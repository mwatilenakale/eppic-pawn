import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store/index.ts';
import type { Rules } from '../playbook/index.ts';
import { can } from '../staff/access.ts';
import { InspectionQueue, InspectionError, type CheckResult, type WorksheetLine } from './queue.ts';
import { inspectionQueuePage, inspectionWorksheetPage } from '../web/inspections.ts';

/** Keep HTTP parsing separate from the queue contract; no direct job SQL. */
export async function inspectionRequest(request: IncomingMessage, response: ServerResponse, url: URL, store: Store, rules: Rules,
  readBody: (request: IncomingMessage) => Promise<Buffer>, html: (response: ServerResponse, status: number, body: string) => void,
): Promise<boolean> {
  const match = /^\/staff\/([A-Za-z0-9_-]{20,64})\/inspections(?:\/(claim)|\/job\/([A-Za-z0-9-]+))?\/?$/.exec(url.pathname);
  if (!match) return false;
  const user = store.staffByToken(match[1]!);
  const missing = () => { response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('Not found'); return true; };
  if (!user || !can(user, 'inspections.work')) return missing();
  if (request.method !== 'GET' && request.method !== 'POST') return missing();
  const token = match[1]!, root = `/staff/${token}/inspections`, queue = new InspectionQueue(store, rules);
  const renderQueue = (status = 200, error = '') => html(response, status, inspectionQueuePage(root, token, user.name, queue.waiting(), queue.mine(user.id), queue.outstanding().filter((job) => job.status === 'claimed' && job.claimedBy !== user.id), error));
  const jobId = match[3];
  const job = jobId ? queue.job(jobId) : null;
  if (jobId && (!job || job.status === 'cancelled')) return missing();
  let draftLines: WorksheetLine[] | undefined;
  let draftFindings: string | undefined;
  const renderJob = (status = 200, error = '') => {
    const current = queue.job(jobId!)!;
    const editable = current.status === 'claimed' && current.claimedBy === user.id;
    html(response, status, inspectionWorksheetPage(root, token, editable && draftFindings !== undefined ? { ...current, findings: draftFindings } : current, editable && draftLines ? draftLines : queue.worksheet(current.id), editable, error));
  };
  if (request.method === 'GET') {
    if (match[2]) return missing();
    if (job) renderJob(); else renderQueue();
    return true;
  }
  const form = new URLSearchParams((await readBody(request)).toString('utf8'));
  // A bearer URL must not permit blind cross-site form posts to change a job.
  if (form.get('csrf') !== token || (request.headers.origin && request.headers.origin !== url.origin)) {
    response.writeHead(403, { 'cache-control': 'no-store' }); response.end('Invalid form'); return true;
  }
  try {
    if (match[2]) {
      const claimed = queue.claim(form.get('jobId') ?? '', user);
      response.writeHead(303, { location: `${root}/job/${claimed.id}`, 'cache-control': 'no-store' }); response.end();
    } else if (job) {
      const action = form.get('action');
      if (!['save', 'submit', 'release'].includes(action ?? '')) throw new InspectionError('Choose save, submit or release.');
      if (action === 'release') queue.release(job.id, user);
      else {
        const lines = queue.worksheet(job.id);
        const results: CheckResult[] = [];
        for (const line of lines) {
          const answer = form.get(`answer:${line.checkId}`);
          if (!answer) continue;
          if (answer !== 'pass' && answer !== 'fail' && answer !== 'na') throw new InspectionError('Invalid check answer.');
          // Stored as typed. The note is the inspector's own evidence and is
          // never redacted on the way out, so there is nothing to restore on
          // the way back in — the round-trip that used to be here is what
          // turned a real figure into "[amount withheld]" on the first edit.
          results.push({ checkId: line.checkId, text: line.text, answer, note: form.get(`note:${line.checkId}`) ?? '' });
        }
        draftLines = lines.map((line) => ({ ...line, answer: results.find((result) => result.checkId === line.checkId)?.answer ?? null, note: form.get(`note:${line.checkId}`) ?? '' }));
        draftFindings = form.get('findings') ?? '';
        if (action === 'submit') queue.submit({ jobId: job.id, user, results, findings: draftFindings });
        else queue.record(job.id, user, results, draftFindings);
      }
      response.writeHead(303, { location: action === 'release' ? root : `${root}/job/${job.id}`, 'cache-control': 'no-store' }); response.end();
    } else return missing();
  } catch (error) {
    if (!(error instanceof InspectionError)) throw error;
    if (job) renderJob(400, error.message); else renderQueue(409, error.message);
  }
  return true;
}
