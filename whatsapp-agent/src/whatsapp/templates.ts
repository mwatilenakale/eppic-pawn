/opt/homebrew/Library/Homebrew/cmd/shellenv.sh: line 18: /bin/ps: Operation not permitted
/** Deployment identifiers, not business rules. Draft bodies: docs/message-templates.md. */
export const TEMPLATES = {
  outcome: { name: 'eppic_outcome_v1', language: 'en', parameters: ['update'] },
  reminder: { name: 'eppic_payment_reminder_v1', language: 'en', parameters: ['reference', 'amount', 'dueDate', 'days'] },
  final: { name: 'eppic_final_notice_v1', language: 'en', parameters: ['reference', 'amount', 'graceEnd'] },
  inspection: { name: 'eppic_inspection_passed_v1', language: 'en', parameters: ['reference', 'signingLink'] },
} as const;

export interface TemplateMessage {
  to: string;
  name: string;
  language: string;
  parameters: string[];
  /** Original text for the local transcript/simulator; not sent as a payload field. */
  body: string;
}

export function templateFor(kind: keyof typeof TEMPLATES, to: string, body: string, parameters: string[]): TemplateMessage {
  const definition = TEMPLATES[kind];
  if (parameters.length !== definition.parameters.length || parameters.some((value) => !value.trim())) {
    throw new Error(`Invalid parameters for ${definition.name}`);
  }
  return { to, body, name: definition.name, language: definition.language,
    parameters: parameters.map((value) => value.replace(/\s+/g, ' ').trim()) };
}

/** Existing application, contract, repayment, manual and staff updates share this envelope. */
export function updateTemplate(to: string, body: string): TemplateMessage {
  return templateFor('outcome', to, body, [body]);
}
