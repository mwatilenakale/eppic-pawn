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

/** How long a signing link stays valid. */
const DEFAULT_VALID_DAYS = 7;

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
      throw new ContractError(`The signing link for contract ${contract.number} has expired — ask Lukas for a new one`);
    }
    return contract;
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
