/**
 * Issuing contracts (architecture 2.5, playbook section 7).
 *
 * A contract exists only for an application Lukas approved, is filled from that
 * approval's amount and the playbook's rules, and is signed online before
 * handover — replacing the manual Loan-ID lookup step. The document is stored
 * exactly as the customer saw it, with its digest, so what was signed can be
 * proved later.
 */

import { randomBytes } from 'node:crypto';
import { formatAmount } from '../money.ts';
import type { Rules } from '../playbook/index.ts';
import { ContractError, type Contract, type Store } from '../store/index.ts';
import { addDays } from '../valuation.ts';
import { buildContract, type ContractDocument } from './document.ts';

export * from './document.ts';
export { signingPage, signedPage, contractErrorPage } from './page.ts';

/** A signature bigger than this is not a signature. */
const MAX_SIGNATURE_BYTES = 1_000_000;

/** How long a signing link stays valid. */
const DEFAULT_VALID_DAYS = 7;

export interface SignedContract {
  contract: Contract;
  loanId: string;
  customerPhone: string;
  customerMessage: string;
  ownerMessage: string;
}

export interface IssuedContract {
  contract: Contract;
  document: ContractDocument;
  signingUrl: string;
  customerMessage: string;
  ownerMessage: string;
}

export interface ContractServiceOptions {
  /** Public origin the signing link is built from, e.g. https://eppic.example. */
  baseUrl: string;
  validDays?: number;
  clock?: () => Date;
}

export class ContractService {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #options: Required<ContractServiceOptions>;

  constructor(store: Store, rules: Rules, options: ContractServiceOptions) {
    this.#store = store;
    this.#rules = rules;
    this.#options = {
      validDays: DEFAULT_VALID_DAYS,
      clock: () => new Date(),
      ...options,
    };
  }

  /**
   * Generates the contract for an approved application. Re-issuing voids the
   * previous unsigned contract rather than leaving two live links.
   */
  issueForApproval(approvalId: string, options: { referral?: boolean; actor: string }): IssuedContract {
    const approval = this.#store.approval(approvalId);
    if (!approval) throw new ContractError(`No such approval: ${approvalId}`);
    if (approval.status !== 'approved' || approval.approved_loan_cents === null) {
      throw new ContractError('A contract can only be issued for an approved application');
    }

    const existing = this.#store.contractsForApproval(approvalId);
    if (existing.some((contract) => contract.status === 'signed')) {
      throw new ContractError('This application already has a signed contract');
    }
    for (const contract of existing.filter((entry) => entry.status === 'pending')) {
      this.#store.voidContract(contract.id, 'replaced by a re-issued contract', options.actor);
    }

    const item = this.#store.item(approval.item_id)!;
    const customer = this.#store.db
      .prepare('SELECT * FROM customers WHERE id = ?')
      .get(item.customer_id) as unknown as { id: string; phone: string; name: string | null; id_number: string | null };

    const today = this.#options.clock().toISOString().slice(0, 10);
    const number = this.#store.nextContractNumber(Number(today.slice(0, 4)));

    const document = buildContract(
      {
        number,
        customer,
        item,
        principalCents: approval.approved_loan_cents,
        referral: options.referral,
        startDate: today,
      },
      this.#rules,
    );

    const token = randomBytes(24).toString('base64url');
    const contract = this.#store.createContract({
      approvalId,
      customerId: customer.id,
      itemId: item.id,
      number,
      token,
      principalCents: document.terms.principalCents,
      ratePct: document.terms.ratePct,
      rateRule: document.terms.rule.id,
      termDays: document.terms.termDays,
      interestCents: document.terms.interestCents,
      totalDueCents: document.terms.totalDueCents,
      startDate: document.schedule.startDate,
      dueDate: document.schedule.dueDate,
      graceEndsDate: document.schedule.graceEndsDate,
      bodyHtml: document.html,
      expiresAt: `${addDays(today, this.#options.validDays)}T23:59:59Z`,
      actor: options.actor,
    });

    const signingUrl = this.signingUrl(token);

    return {
      contract,
      document,
      signingUrl,
      customerMessage: this.#customerMessage(document, signingUrl),
      ownerMessage:
        `Contract ${number} is ready for ${customer.name ?? customer.phone} — ${formatAmount(document.terms.principalCents)} at ${document.terms.ratePct}% over ${document.terms.termDays} days.\n` +
        `They have been sent the signing link. The loan starts when they sign and hand the item over, not before.`,
    };
  }

  signingUrl(token: string): string {
    return `${this.#options.baseUrl.replace(/\/$/, '')}/c/${token}`;
  }

  /** The contract behind a signing link, if the link is still usable. */
  openForSigning(token: string): Contract {
    const contract = this.#store.contractByToken(token);
    if (!contract) throw new ContractError('No contract matches that link');
    if (contract.status === 'void') throw new ContractError(`Contract ${contract.number} was cancelled`);
    if (contract.status === 'signed') return contract;
    if (this.#options.clock().toISOString() > contract.expires_at) {
      // A customer reads this one, so it says the role (playbook header).
      throw new ContractError(
        `The signing link for contract ${contract.number} has expired — message us on WhatsApp for a new one`,
      );
    }
    return contract;
  }

  /**
   * Records the signature and starts the loan.
   *
   * This is the point the money becomes real: the loan row is written and the
   * ledger is opened with the principal and the term's interest, so the balance
   * is what the contract says is due. Everything is refused rather than
   * half-applied — a bad signature leaves no loan behind.
   */
  sign(token: string, submission: { name: string; idNumber: string; signatureDataUrl: string }): SignedContract {
    const contract = this.openForSigning(token);
    if (contract.status === 'signed') throw new ContractError(`Contract ${contract.number} is already signed`);

    const name = submission.name.trim();
    const idNumber = submission.idNumber.trim();
    if (name.length < 3) throw new ContractError('Please enter your full name as it appears on your ID');
    if (idNumber.length < 4) throw new ContractError('Please enter your ID number');

    const image = readSignatureImage(submission.signatureDataUrl);
    if (!image) throw new ContractError('Please sign in the box before submitting');

    // Handoff: the loan, ledger, signature record and audit must succeed
    // together. In particular, a full media disk must not leave an unsigned
    // contract owing money, or make a retry create a second loan.
    return this.#store.transaction(() => this.#completeSigning(contract, name, idNumber, image));
  }

  #completeSigning(contract: Contract, name: string, idNumber: string, image: Buffer): SignedContract {
    const item = this.#store.item(contract.item_id)!;
    const loan = this.#store.createLoan({
      customerId: contract.customer_id,
      itemId: contract.item_id,
      approvalId: contract.approval_id,
      principalCents: contract.principal_cents,
      ratePct: contract.rate_pct,
      rateRule: contract.rate_rule,
      termDays: contract.term_days,
      interestCents: contract.interest_cents,
      startDate: contract.start_date,
      dueDate: contract.due_date,
      graceEndsDate: contract.grace_ends_date,
      actor: contract.customer_id,
    });

    // A pawn loan's interest is fixed for the term, not accrued daily, so both
    // sides of what is owed are posted at the start. Positive = owed by the
    // customer; repayments are posted negative.
    this.#store.postLedgerEntry({
      loanId: loan.id,
      entryType: 'principal',
      amountCents: contract.principal_cents,
      memo: `Contract ${contract.number}`,
      actor: contract.customer_id,
    });
    this.#store.postLedgerEntry({
      loanId: loan.id,
      entryType: 'interest',
      amountCents: contract.interest_cents,
      memo: `${contract.rate_pct}% over ${contract.term_days} days`,
      actor: contract.customer_id,
    });

    const signed = this.#store.signContract({
      contractId: contract.id,
      name,
      idNumber,
      image,
      loanId: loan.id,
      actor: contract.customer_id,
    });
    this.#store.updateItem(item.id, { status: 'pledged' });

    const customerPhone = (
      this.#store.db.prepare('SELECT phone FROM customers WHERE id = ?').get(contract.customer_id) as { phone: string }
    ).phone;

    return {
      contract: signed,
      loanId: loan.id,
      customerPhone,
      customerMessage:
        `Contract ${contract.number} is signed — thank you, ${name}.\n\n` +
        `Bring the item and your documents in to collect ${formatAmount(contract.principal_cents)}. ` +
        `${formatAmount(contract.total_due_cents)} is due by ${contract.due_date}, with a grace period to ${contract.grace_ends_date}.`,
      ownerMessage:
        `✍️ ${name} signed contract ${contract.number} (${formatAmount(contract.principal_cents)} on ${item.description || 'the item'}).\n` +
        `ID given: ${idNumber}\n` +
        `The loan is open: ${formatAmount(contract.total_due_cents)} due ${contract.due_date}. Verify the in-person checks before handing over the money.`,
    };
  }

  #customerMessage(document: ContractDocument, signingUrl: string): string {
    return [
      `Your agreement is ready — contract ${document.number}.`,
      '',
      `Loan: ${formatAmount(document.terms.principalCents)}`,
      `To repay: ${formatAmount(document.terms.totalDueCents)} by ${document.schedule.dueDate} (${document.terms.ratePct}% over ${document.terms.termDays} days)`,
      `Grace period: ${document.terms.graceDays} days, until ${document.schedule.graceEndsDate}`,
      '',
      'Read and sign it here before you come in:',
      signingUrl,
      '',
      'Bring with you:',
      ...document.requirements.map((requirement) => `• ${requirement}`),
    ].join('\n');
  }
}


/** Reads the PNG the signature pad produced, rejecting anything else. */
function readSignatureImage(dataUrl: string): Buffer | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? '').trim());
  if (!match) return null;

  const image = Buffer.from(match[1]!, 'base64');
  if (image.length === 0 || image.length > MAX_SIGNATURE_BYTES) return null;
  // PNG magic number — the pad produces one; anything else is not from it.
  if (!image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  return image;
}
