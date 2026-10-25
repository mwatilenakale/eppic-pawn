/**
 * The shop-floor inspection, as a job somebody owns.
 *
 * Lukas approves an item in principle; the customer brings it in; a job
 * appears here. A member of staff claims it, works the checklist for that
 * exact item, writes what they found, and submits. Only then does the final
 * approval go back to Lukas and the agreement open for signing.
 *
 * Two properties are load-bearing, and both are enforced here rather than in
 * whatever renders the page:
 *
 * **No money, ever.** Nothing this module returns carries a valuation, a loan
 * figure or a ledger balance, and it has no way to reach one. An inspector who
 * knows the target has a reason to wave something through — the same worry the
 * playbook already has about letting a customer pick the car mechanic. A page
 * built from this module cannot leak a figure because it was never given one.
 *
 * **One job, one owner.** A job is claimed before it is worked, and only the
 * person holding it can submit it. Two people half-checking the same phone is
 * how a check ends up skipped by both of them.
 *
 * The checks themselves are not written here. They come from the playbook and
 * the architecture document at runtime, like every other rule.
 */

import { randomUUID } from 'node:crypto';
import type { Rules } from '../playbook/index.ts';
import type { Store, User } from '../store/index.ts';
import { buildQuestionPlan } from '../intake/questions.ts';
import { can } from '../staff/access.ts';

export type JobStatus = 'open' | 'claimed' | 'submitted' | 'cancelled';
export type CheckAnswer = 'pass' | 'fail' | 'na';

/** The same three values at runtime, where the type is no longer present. */
const ANSWERS: readonly CheckAnswer[] = ['pass', 'fail', 'na'];

export interface CheckResult {
  checkId: string;
  /** The check as written in the documents, kept so the record reads alone. */
  text: string;
  answer: CheckAnswer;
  note: string;
}

/** A line on the worksheet: what to check, and what has been said about it. */
export interface WorksheetLine {
  checkId: string;
  text: string;
  /** `playbook` (section 6) or `fraud` (architecture 2.3). */
  source: string;
  /** The playbook marks some rules `[decide]` — proposed, not settled policy. */
  provisional: boolean;
  answer: CheckAnswer | null;
  note: string;
}

/**
 * Everything a staff member may see about a job. Note what is absent: no
 * valuation, no loan, no balance, no customer phone number, no ID photo.
 */
export interface Job {
  id: string;
  status: JobStatus;
  itemId: string;
  /** What the customer said it is. */
  description: string;
  categorySlug: string;
  variant: string | null;
  /** First name only — enough to match the person at the counter. */
  customerName: string | null;
  /** What the customer already confirmed remotely, for the inspector to test. */
  declared: { question: string; answer: string }[];
  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: string | null;
  createdAt: string;
  submittedAt: string | null;
  outcome: 'pass' | 'fail' | null;
  findings: string;
}

export class InspectionError extends Error {}

export class InspectionQueue {
  readonly #store: Store;
  readonly #rules: Rules;

  constructor(store: Store, rules: Rules) {
    this.#store = store;
    this.#rules = rules;
  }

  /** Opened when Lukas approves in principle. Idempotent per item. */
  open(input: { itemId: string; approvalId?: string | null; actor: string }): Job {
    const live = this.#store.db
      .prepare("SELECT id FROM inspection_jobs WHERE item_id = ? AND status IN ('open', 'claimed')")
      .get(input.itemId) as { id: string } | undefined;
    if (live) return this.job(live.id)!;

    const id = randomUUID();
    this.#store.db
      .prepare('INSERT INTO inspection_jobs (id, item_id, approval_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.itemId, input.approvalId ?? null, 'open', new Date().toISOString());
    this.#store.audit({ actor: input.actor, action: 'inspection.opened', entity: 'inspection_job', entityId: id, details: { itemId: input.itemId } });
    return this.job(id)!;
  }

  /** Unclaimed, oldest first — the one that has waited longest is next. */
  waiting(): Job[] {
    return this.#jobs("j.status = 'open'");
  }

  /** Jobs this person is holding. */
  mine(userId: string): Job[] {
    return this.#jobs("j.status = 'claimed' AND j.claimed_by = ?", [userId]);
  }

  /** Everything still to do — unclaimed first, then what is in hand. */
  outstanding(): Job[] {
    return this.#jobs("j.status IN ('open', 'claimed')");
  }

  job(jobId: string): Job | null {
    return this.#jobs('j.id = ?', [jobId])[0] ?? null;
  }

  /**
   * Takes a job. Refuses one somebody else is already holding — including
   * Lukas's, because "I'll just do this one" while the hire is halfway
   * through it is exactly the collision the claim exists to prevent.
   */
  claim(jobId: string, user: User): Job {
    if (!can(user, 'inspections.work')) throw new InspectionError('You cannot take inspection jobs.');

    const job = this.job(jobId);
    if (!job) throw new InspectionError('That job no longer exists.');
    if (job.status === 'submitted') throw new InspectionError('That job has already been done.');
    if (job.status === 'cancelled') throw new InspectionError('That job was cancelled.');
    if (job.status === 'claimed' && job.claimedBy !== user.id) {
      throw new InspectionError(`${job.claimedByName ?? 'Someone else'} is already working on that one.`);
    }

    this.#store.db
      .prepare("UPDATE inspection_jobs SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?")
      .run(user.id, new Date().toISOString(), jobId);
    this.#store.audit({ actor: user.id, action: 'inspection.claimed', entity: 'inspection_job', entityId: jobId });
    return this.job(jobId)!;
  }

  /** Puts a job back in the queue — picked up the wrong one, or going home. */
  release(jobId: string, user: User): Job {
    const job = this.job(jobId);
    if (!job) throw new InspectionError('That job no longer exists.');
    if (job.status !== 'claimed') throw new InspectionError('That job is not claimed.');
    if (job.claimedBy !== user.id && !can(user, 'approvals.decide')) {
      throw new InspectionError('Only the person holding a job can put it back.');
    }

    this.#store.db
      .prepare("UPDATE inspection_jobs SET status = 'open', claimed_by = NULL, claimed_at = NULL WHERE id = ?")
      .run(jobId);
    this.#store.audit({ actor: user.id, action: 'inspection.released', entity: 'inspection_job', entityId: jobId });
    return this.job(jobId)!;
  }

  /**
   * The checklist for this exact item, from the documents, merged with
   * whatever has been answered so far. The order is the documents' order.
   */
  worksheet(jobId: string): WorksheetLine[] {
    const job = this.job(jobId);
    if (!job) throw new InspectionError('That job no longer exists.');

    const answered = new Map(this.#results(jobId).map((result) => [result.checkId, result]));

    return buildQuestionPlan(this.#rules, job.categorySlug, job.variant).inPersonChecks.map((check) => ({
      checkId: check.id,
      text: check.text,
      source: check.source,
      provisional: check.provisional,
      answer: answered.get(check.id)?.answer ?? null,
      note: answered.get(check.id)?.note ?? '',
    }));
  }

  /** Saves progress without finishing. A long inspection survives a dropped phone. */
  record(jobId: string, user: User, results: CheckResult[], findings?: string): void {
    const job = this.#claimedBy(jobId, user);
    // Validated on a progress save as well as on submit: a half-finished
    // sheet is still a sheet somebody will read, and the page posts the same
    // form either way.
    const clean = this.#validate(job.id, results);
    this.#store.db
      .prepare('UPDATE inspection_jobs SET results = ?, findings = ? WHERE id = ?')
      .run(JSON.stringify(clean), findings ?? job.findings, job.id);
  }

  /**
   * Checks the answers are actually answers, before anything is written.
   *
   * `CheckAnswer` is `'pass' | 'fail' | 'na'`, and until now that was the only
   * thing enforcing it — which is worth nothing, because these values arrive
   * from an HTML form at runtime and TypeScript is gone by then.
   *
   * Codex's twenty-scenario audit, scenario 18: it submitted every check with
   * the answer `approved-by-client` and got `status=submitted; outcome=pass`.
   * The completeness check asked only whether the field was truthy, and the
   * outcome was "fail if any answer is the exact string fail" — so an invalid
   * answer satisfied both and a worksheet nobody had really filled in came
   * out of the far end marked as passed.
   *
   * Enforced here, in the domain layer, rather than in the page: a second
   * caller — the page that is still to be built, a repair script, a future
   * import — must not be able to get past it by not knowing the rule.
   */
  #validate(jobId: string, results: CheckResult[]): CheckResult[] {
    const known = new Map(this.worksheet(jobId).map((line) => [line.checkId, line.text]));
    const seen = new Set<string>();
    const clean: CheckResult[] = [];

    for (const result of results) {
      if (!known.has(result.checkId)) {
        throw new InspectionError(`There is no check "${result.checkId}" on this worksheet.`);
      }
      if (seen.has(result.checkId)) {
        // Two answers for one check is not something a person does by hand;
        // it is a form posted twice or a script, and silently keeping one of
        // them would decide which at random.
        throw new InspectionError(`Check "${known.get(result.checkId)}" was answered twice.`);
      }
      if (!ANSWERS.includes(result.answer)) {
        throw new InspectionError(
          `"${String(result.answer)}" is not an answer. Every check is pass, fail or n/a.`,
        );
      }

      seen.add(result.checkId);
      // The text is taken from the worksheet, never from the caller: a report
      // Lukas reads must say what was actually checked.
      clean.push({
        checkId: result.checkId,
        text: known.get(result.checkId)!,
        answer: result.answer,
        note: typeof result.note === 'string' ? result.note : '',
      });
    }

    return clean;
  }

  /**
   * Finishes it. Refuses while any line is unanswered — the whole point of
   * the worksheet is that "all checks done" means all of them, so a half-filled
   * sheet must not be able to reach Lukas looking complete.
   *
   * Does not approve anything. It hands a report to Lukas, who decides.
   */
  submit(input: { jobId: string; user: User; results: CheckResult[]; findings: string }): Job {
    const job = this.#claimedBy(input.jobId, input.user);

    // Validated first, so an invalid answer cannot satisfy the completeness
    // check on its way to being counted as a pass.
    const results = this.#validate(job.id, input.results);

    const required = this.worksheet(job.id);
    const answered = new Map(results.map((result) => [result.checkId, result]));
    const missing = required.filter((line) => !answered.get(line.checkId)?.answer);
    if (missing.length > 0) {
      throw new InspectionError(
        `${missing.length} check${missing.length === 1 ? ' is' : 's are'} still unanswered: ${missing.map((line) => line.text).join('; ')}`,
      );
    }

    if (!input.findings.trim()) {
      throw new InspectionError('Say what you found, in your own words — even one line.');
    }

    // Any failed check fails the inspection. Lukas can still choose to take the
    // item; what he cannot do is not be told.
    const outcome = results.some((result) => result.answer === 'fail') ? 'fail' : 'pass';
    const at = new Date().toISOString();

    this.#store.db
      .prepare("UPDATE inspection_jobs SET status = 'submitted', results = ?, findings = ?, outcome = ?, submitted_at = ? WHERE id = ?")
      .run(JSON.stringify(results), input.findings.trim(), outcome, at, job.id);

    // Also recorded against the item, where the rest of its history lives.
    this.#store.saveInspection({
      itemId: job.itemId,
      stage: 'in-person',
      results,
      outstanding: results.filter((result) => result.answer === 'fail').map((result) => result.text),
      complete: true,
      recordedBy: input.user.id,
    });

    this.#store.audit({
      actor: input.user.id,
      action: 'inspection.submitted',
      entity: 'inspection_job',
      entityId: job.id,
      details: { outcome, failed: results.filter((result) => result.answer === 'fail').length },
    });

    return this.job(job.id)!;
  }

  /** The results as stored, for a submitted job's report. */
  results(jobId: string): CheckResult[] {
    return this.#results(jobId);
  }

  // --- internals -----------------------------------------------------------

  #claimedBy(jobId: string, user: User): Job {
    const job = this.job(jobId);
    if (!job) throw new InspectionError('That job no longer exists.');
    if (job.status === 'submitted') throw new InspectionError('That job has already been submitted.');
    if (job.claimedBy !== user.id) {
      throw new InspectionError('Claim the job first — a job is worked by the person holding it.');
    }
    return job;
  }

  #results(jobId: string): CheckResult[] {
    const row = this.#store.db.prepare('SELECT results FROM inspection_jobs WHERE id = ?').get(jobId) as
      | { results: string }
      | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.results) as CheckResult[];
    } catch {
      return [];
    }
  }

  /**
   * The only place a Job is built. Every column it reads is listed here, which
   * is what makes "this module cannot return a figure" checkable by reading
   * one function rather than trusting the whole file.
   */
  #jobs(where: string, parameters: unknown[] = []): Job[] {
    const rows = this.#store.db
      .prepare(
        `SELECT j.id, j.status, j.item_id, j.approval_id, j.claimed_by, j.claimed_at,
                j.created_at, j.submitted_at, j.outcome, j.findings,
                i.description, i.category_slug, i.variant, i.declared_details,
                c.name AS customer_name, u.name AS claimed_by_name
         FROM inspection_jobs j
         JOIN items i ON i.id = j.item_id
         LEFT JOIN customers c ON c.id = i.customer_id
         LEFT JOIN users u ON u.id = j.claimed_by
         WHERE ${where}
         ORDER BY j.created_at`,
      )
      .all(...(parameters as never[])) as Record<string, string | null>[];

    return rows.map((row) => ({
      id: String(row['id']),
      status: String(row['status']) as JobStatus,
      itemId: String(row['item_id']),
      description: String(row['description'] ?? ''),
      categorySlug: String(row['category_slug'] ?? ''),
      variant: row['variant'] ?? null,
      customerName: firstName(row['customer_name']),
      declared: readDeclared(row['declared_details']),
      claimedBy: row['claimed_by'] ?? null,
      claimedByName: row['claimed_by_name'] ?? null,
      claimedAt: row['claimed_at'] ?? null,
      createdAt: String(row['created_at']),
      submittedAt: row['submitted_at'] ?? null,
      outcome: (row['outcome'] as 'pass' | 'fail' | null) ?? null,
      findings: String(row['findings'] ?? ''),
    }));
  }
}

/**
 * Enough to greet the person at the counter, not their full identity. The
 * inspector is testing a phone, not opening a credit file.
 */
function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0] ?? null;
}

/** What the customer already confirmed remotely, so staff can test the claims. */
function readDeclared(json: string | null | undefined): { question: string; answer: string }[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is { question: string; answer: string } =>
        typeof entry === 'object' && entry !== null && 'question' in entry && 'answer' in entry)
      .map((entry) => ({ question: String(entry.question), answer: String(entry.answer) }));
  } catch {
    return [];
  }
}

