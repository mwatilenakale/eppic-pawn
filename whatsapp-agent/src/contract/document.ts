/**
 * The pawn agreement itself (architecture 2.5): auto-filled from the confirmed
 * item and the amount Lukas approved, with the document checklist that is
 * already category-specific in the playbook.
 *
 * Every figure and every rule in the document is read from `docs/playbook.md`
 * through the same loader the rest of the system uses — the rate, the term, the
 * grace period, what happens on default, what the customer must bring. If Lukas
 * changes a rate in the playbook, the next contract carries the new one.
 *
 * ⚠️ The wording here is plain-language and derived from the playbook; it has
 * not been reviewed by a lawyer. Have one read it before it is used with real
 * customers — see `docs/architecture.md` Section 0 for the related open
 * regulatory question.
 */

import { formatAmount } from '../money.ts';
import { escapeHtml } from '../html.ts';
import type { Rules } from '../playbook/index.ts';
import type { Customer, Item } from '../store/index.ts';
import { loanTerms, schedule, type LoanTerms, type Schedule } from '../valuation.ts';

export { escapeHtml };

/**
 * The shop's legal identity. Not business *rules*, so not in the playbook —
 * these do not change without a trip to BIPA.
 *
 * The WhatsApp number is deliberately absent: it is a contact detail that does
 * change, it appears on contracts and on the website, and a second copy here
 * would quietly go stale the first time the shop moves number. It comes from
 * the playbook's header instead — `rules.playbook.whatsapp`.
 */
export const BUSINESS = {
  name: 'Mwatile Eppic Investment CC',
  tradingAs: 'Eppic Pawn Shop',
  place: 'Windhoek, Namibia',
} as const;

export interface ContractInput {
  number: string;
  customer: Customer;
  item: Item;
  principalCents: number;
  /** Someone brought the customer in — playbook section 4's referral row. */
  referral?: boolean;
  startDate: string;
}

export interface ContractDocument {
  number: string;
  terms: LoanTerms;
  schedule: Schedule;
  /** What the customer must bring, from playbook section 5 + the category. */
  requirements: string[];
  /** Declarations the customer makes by signing. */
  declarations: string[];
  html: string;
  text: string;
}

/** Declarations that apply to every pledge. */
const GENERAL_DECLARATIONS = [
  'The item described above is mine. I own it outright and nobody else has a claim over it.',
  'The item is not stolen, and I have not reported it lost or stolen.',
  'Everything I have told Eppic Pawn Shop about the item is true, including its make, model and condition.',
];

/** Extra declarations a category needs, keyed by playbook category slug. */
const CATEGORY_DECLARATIONS: Record<string, string[]> = {
  cars: [
    'The vehicle is fully paid off and registered in my own name.',
    'There is no outstanding finance on the vehicle, and I have provided a settlement letter where one applies.',
  ],
  phones: ['All accounts have been signed out of the device and any activation lock has been removed.'],
  laptops: ['All passwords and accounts have been removed from the laptop, and it is not locked to an organisation.'],
  tvs: ['All accounts have been signed out of the television.'],
  consoles: ['All accounts and profiles have been removed from the console.'],
};

export function buildContract(input: ContractInput, rules: Rules): ContractDocument {
  const terms = loanTerms({ principalCents: input.principalCents, referral: input.referral }, rules);
  const dates = schedule(input.startDate, terms, rules);

  const requirements = rules.playbook.requirements;
  const declarations = [...GENERAL_DECLARATIONS, ...(CATEGORY_DECLARATIONS[input.item.category_slug] ?? [])];

  const sections = buildSections(input, rules, terms, dates);

  return {
    number: input.number,
    terms,
    schedule: dates,
    requirements,
    declarations,
    html: renderHtml(input, sections, declarations),
    text: renderText(input, sections, declarations),
  };
}

interface Section {
  heading: string;
  rows?: [string, string][];
  paragraphs?: string[];
  bullets?: string[];
}

function buildSections(input: ContractInput, rules: Rules, terms: LoanTerms, dates: Schedule): Section[] {
  const { playbook } = rules;
  const category = rules.categories.find((entry) => entry.slug === input.item.category_slug);

  return [
    {
      heading: 'Parties',
      rows: [
        ['Pawnbroker', `${BUSINESS.name} t/a ${BUSINESS.tradingAs}, ${BUSINESS.place} (WhatsApp ${rules.playbook.whatsapp})`],
        ['Customer', input.customer.name ?? '(name to be confirmed at handover)'],
        ['Customer ID number', input.customer.id_number ?? '(to be confirmed at handover)'],
        ['Customer phone', input.customer.phone],
      ],
    },
    {
      heading: 'The pledged item',
      rows: [
        ['Category', category?.label ?? input.item.category_slug],
        ...(input.item.variant ? ([['Type', input.item.variant]] as [string, string][]) : []),
        ['Description', input.item.description || '(as inspected at handover)'],
      ],
      paragraphs: [
        'The item stays with Eppic Pawn Shop as security for the loan until the amount below is paid in full.',
      ],
    },
    {
      heading: 'The loan',
      rows: [
        ['Amount lent', formatAmount(terms.principalCents)],
        ['Interest', `${terms.ratePct}% of the amount lent (${formatAmount(terms.interestCents)})`],
        ['Total to repay', formatAmount(terms.totalDueCents)],
        ['Term', `${terms.termDays} days`],
        ['Date of loan', dates.startDate],
        ['Due date', dates.dueDate],
        ['Grace period', `${terms.graceDays} days — until ${dates.graceEndsDate}`],
      ],
      paragraphs: [
        `Paying ${formatAmount(terms.totalDueCents)} on or before ${dates.graceEndsDate} settles the loan and the item is returned.`,
        `A longer grace period of up to ${playbook.grace.flexibleUpToDays} days (until ${dates.extendedGraceEndsDate}) may be agreed on request before the due date.`,
      ],
    },
    {
      heading: 'Paying part of what is owed',
      paragraphs: [
        playbook.partialPaymentCompounds
          ? 'If only part of the interest is paid, the shortfall is added to the amount lent and interest is charged on the new total from then on. It is not written off.'
          : 'Partial payments are applied to interest first, then to the amount lent.',
      ],
    },
    {
      heading: 'If the loan is not repaid',
      bullets: [
        `Once the grace period ends on ${dates.graceEndsDate}, Eppic Pawn Shop will contact the customer directly.`,
        `Eppic Pawn Shop then compares what is owed against what the item will sell for. While roughly ${playbook.collections.marginThresholdPct}% or more of that value is still left over after what is owed, the loan may be extended by a further month instead of the item being sold.`,
        'Once that margin is gone, the item is sold to recover the loan and the interest owed. It is priced to sell quickly rather than for the highest possible price.',
        'The customer may redeem the item at any point before it is sold, by paying everything then owed.',
      ],
    },
    {
      heading: 'What the customer provides',
      bullets: rules.playbook.requirements,
    },
  ];
}

function renderText(input: ContractInput, sections: Section[], declarations: string[]): string {
  const lines: string[] = [
    `${BUSINESS.tradingAs.toUpperCase()} — PAWN AGREEMENT`,
    `Contract ${input.number}`,
    '',
  ];

  for (const section of sections) {
    lines.push(section.heading.toUpperCase(), '');
    for (const [label, value] of section.rows ?? []) lines.push(`  ${label}: ${value}`);
    for (const paragraph of section.paragraphs ?? []) lines.push(`  ${paragraph}`);
    for (const bullet of section.bullets ?? []) lines.push(`  • ${bullet}`);
    lines.push('');
  }

  lines.push('DECLARATIONS BY THE CUSTOMER', '');
  for (const declaration of declarations) lines.push(`  • ${declaration}`);
  lines.push('', 'SIGNATURE', '', '  Signed: ______________________    Date: ____________', '');

  return lines.join('\n');
}

function renderHtml(input: ContractInput, sections: Section[], declarations: string[]): string {
  const body = sections
    .map((section) => {
      const rows = (section.rows ?? [])
        .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
        .join('');
      const paragraphs = (section.paragraphs ?? []).map((text) => `<p>${escapeHtml(text)}</p>`).join('');
      const bullets = (section.bullets ?? []).length
        ? `<ul>${(section.bullets ?? []).map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
        : '';

      return `<section><h2>${escapeHtml(section.heading)}</h2>${rows ? `<table>${rows}</table>` : ''}${paragraphs}${bullets}</section>`;
    })
    .join('');

  return `<article class="contract">
  <header>
    <h1>${escapeHtml(BUSINESS.tradingAs)} — Pawn agreement</h1>
    <p class="meta">${escapeHtml(BUSINESS.name)} · ${escapeHtml(BUSINESS.place)} · Contract ${escapeHtml(input.number)}</p>
  </header>
  ${body}
  <section>
    <h2>Declarations by the customer</h2>
    <ul>${declarations.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>
  </section>
</article>`;
}
