/** Money-blind inspection views. Never fetch valuations or the book here. */
import { escapeHtml } from '../html.ts';
import type { Job, WorksheetLine } from '../inspection/queue.ts';
import { THEME } from './theme.ts';

// Documents and customer-entered descriptions can themselves mention prices.
// Redact only the rendered copy; the original inspection evidence stays intact.
export const inspectionText = (text: string) => text.replace(/(?:N\$|NAD|ZAR|R\$|\$)\s*\d[\d,.]*(?:\s*\/\s*month)?/gi, '[amount withheld]');
const safe = (text: string) => escapeHtml(inspectionText(text));
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

function shell(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Inspections — Eppic</title><style>${THEME}
  main{max-width:760px;margin:auto;padding:var(--space-6)} fieldset,.card{padding:var(--space-4);margin:var(--space-4) 0;border:1px solid var(--border-subtle);border-radius:var(--radius-md)} textarea{display:block;width:100%;min-height:72px} label{display:inline-block;margin:var(--space-2)} .error{color:var(--danger)}
  </style></head><body><main>${body}</main></body></html>`;
}

export function inspectionQueuePage(root: string, token: string, name: string, waiting: Job[], mine: Job[], others: Job[], error = ''): string {
  const row = (job: Job) => {
    const hours = Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt)) / 3_600_000));
    return `<article class="card"><h3>${safe(job.description)}</h3><p>${safe(job.customerName ?? '')} · waiting ${hours}h · ${safe(job.claimedByName ?? 'Unclaimed')}</p>${job.status === 'open'
      ? `<form method="post" action="${root}/claim">${hidden('csrf', token)}${hidden('jobId', job.id)}<button>Take this job</button></form>`
      : job.claimedBy && mine.some((entry) => entry.id === job.id) ? `<a href="${root}/job/${job.id}">Open worksheet</a>` : ''}</article>`;
  };
  return shell(`<h1>Inspections</h1><p>${safe(name)} · This screen approves nothing. Lukas decides over WhatsApp.</p>${error ? `<p role="alert" class="error">${safe(error)}</p>` : ''}<h2>Waiting — oldest first</h2>${waiting.map(row).join('') || '<p>No jobs waiting.</p>'}<h2>My jobs</h2>${mine.map(row).join('') || '<p>No jobs in hand.</p>'}<h2>With someone else</h2>${others.map(row).join('') || '<p>None.</p>'}`);
}

export function inspectionWorksheetPage(root: string, token: string, job: Job, lines: WorksheetLine[], editable: boolean, error = ''): string {
  const submitted = job.status === 'submitted';
  return shell(`<a href="${root}">Inspection queue</a><h1>${safe(job.description)}</h1><p>${safe(job.customerName ?? '')} · ${safe(job.claimedByName ?? 'Unclaimed')}</p>${submitted ? `<p>Submitted ${safe(job.submittedAt ?? '')} · ${safe(job.outcome ?? '')}</p>` : ''}${error ? `<p role="alert" class="error">${safe(error)}</p>` : ''}
  ${editable ? `<form method="post" action="${root}/job/${job.id}">${hidden('csrf', token)}` : ''}
  ${lines.map((line, index) => `<fieldset><legend>${index + 1}. ${safe(line.text)}${line.provisional ? ' (proposed rule)' : ''}</legend>${editable
    ? ['pass', 'fail', 'na'].map((answer) => `<label><input type="radio" name="answer:${line.checkId}" value="${answer}" ${line.answer === answer ? 'checked' : ''} required>${answer === 'na' ? 'N/A' : answer}</label>`).join('') + `<label>Note<textarea name="note:${line.checkId}">${safe(line.note)}</textarea></label>`
    : `<p>${line.answer ?? 'Unanswered'} · ${safe(line.note)}</p>`}</fieldset>`).join('')}
  <h2>Findings</h2>${editable ? `<textarea name="findings" required>${safe(job.findings)}</textarea><button name="action" value="save" formnovalidate>Save progress</button><button name="action" value="submit">Submit report to Lukas</button><button name="action" value="release" formnovalidate>Put job back</button></form>` : `<p>${safe(job.findings)}</p>`}
  <p>Submitting records an inspection only. It does not approve or pay a deal.</p>`);
}
