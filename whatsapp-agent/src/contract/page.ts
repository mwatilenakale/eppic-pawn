/**
 * The page the customer opens on their phone: the agreement as it will be
 * signed, their details, and a finger-signature pad (playbook section 7 —
 * "signed online (finger/touch signature) before handover").
 *
 * Self-contained on purpose. It loads no scripts, fonts or styles from anywhere
 * else, so it works on a slow connection and there is nothing third-party
 * sitting between a customer and their signature.
 */

import { escapeHtml, BUSINESS } from './document.ts';
import { formatAmount } from '../money.ts';
import type { Contract } from '../store/index.ts';

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 1rem; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: #1a1a1a; background: #f6f5f3; }
  main { max-width: 44rem; margin: 0 auto; }
  .card { background: #fff; border: 1px solid #e2ded8; border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .04em; color: #6b6560;
       margin: 1.5rem 0 .5rem; }
  .meta { color: #6b6560; font-size: .875rem; margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: .5rem 0; }
  th { text-align: left; font-weight: 600; color: #6b6560; padding: .35rem .75rem .35rem 0;
       vertical-align: top; width: 40%; }
  td { padding: .35rem 0; }
  ul { padding-left: 1.1rem; margin: .5rem 0; }
  li { margin: .3rem 0; }
  .summary { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin: 1rem 0; }
  .summary div { background: #f6f5f3; border-radius: 8px; padding: .75rem; }
  .summary span { display: block; font-size: .8rem; color: #6b6560; }
  .summary strong { font-size: 1.1rem; }
  label { display: block; font-weight: 600; margin: 1rem 0 .35rem; }
  input[type=text] { width: 100%; padding: .7rem; font-size: 1rem; border: 1px solid #cfc9c2; border-radius: 8px; }
  canvas { width: 100%; height: 180px; border: 2px dashed #cfc9c2; border-radius: 8px; background: #fff;
           touch-action: none; display: block; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: .5rem; }
  button { font: inherit; padding: .8rem 1.2rem; border-radius: 8px; border: 1px solid #cfc9c2;
           background: #fff; cursor: pointer; }
  button[type=submit] { background: #1a5c3a; border-color: #1a5c3a; color: #fff; font-weight: 600; width: 100%;
                        padding: 1rem; font-size: 1.05rem; }
  button[type=submit][disabled] { background: #b9b3ac; border-color: #b9b3ac; cursor: not-allowed; }
  .notice { background: #fff8e6; border: 1px solid #e8d9a8; border-radius: 8px; padding: .9rem; font-size: .925rem; }
  .done { background: #eaf5ee; border: 1px solid #b6dcc3; border-radius: 8px; padding: 1rem; }
  .error { background: #fdeceb; border: 1px solid #f2c0bc; border-radius: 8px; padding: 1rem; }
`;

/** Nothing is submitted until something is actually drawn in the pad. */
const SIGNATURE_SCRIPT = `
  const canvas = document.getElementById('pad');
  const context = canvas.getContext('2d');
  const field = document.getElementById('signature');
  const submit = document.getElementById('submit');
  let drawing = false, signed = false;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#1a1a1a';
  }
  resize();
  window.addEventListener('resize', resize);

  function position(event) {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }
  canvas.addEventListener('pointerdown', (event) => {
    drawing = true; signed = true; submit.disabled = false;
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = position(event);
    context.beginPath(); context.moveTo(x, y);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const [x, y] = position(event);
    context.lineTo(x, y); context.stroke();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    canvas.addEventListener(type, () => { drawing = false; });
  }

  document.getElementById('clear').addEventListener('click', () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    signed = false; submit.disabled = true;
  });

  document.getElementById('form').addEventListener('submit', (event) => {
    if (!signed) { event.preventDefault(); return; }
    field.value = canvas.toDataURL('image/png');
    submit.disabled = true;
    submit.textContent = 'Sending…';
  });
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function signingPage(contract: Contract, options: { error?: string } = {}): string {
  const summary = `
    <div class="summary">
      <div><span>Loan amount</span><strong>${formatAmount(contract.principal_cents)}</strong></div>
      <div><span>To repay</span><strong>${formatAmount(contract.total_due_cents)}</strong></div>
      <div><span>Due date</span><strong>${escapeHtml(contract.due_date)}</strong></div>
      <div><span>Grace period until</span><strong>${escapeHtml(contract.grace_ends_date)}</strong></div>
    </div>`;

  return page(`Sign contract ${contract.number}`, `
    <div class="card">
      <h1>Sign your pawn agreement</h1>
      <p class="meta">${escapeHtml(BUSINESS.tradingAs)} · Contract ${escapeHtml(contract.number)}</p>
      ${summary}
      <p class="notice">Signing does not hand over your item. Bring the item and your documents to
      ${escapeHtml(BUSINESS.place.split(',')[0]!)} — the loan starts when you hand it over.</p>
    </div>

    <div class="card">${contract.body_html}</div>

    <div class="card">
      ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ''}
      <form id="form" method="post" action="">
        <label for="name">Your full name, as it appears on your ID</label>
        <input type="text" id="name" name="name" required autocomplete="name" maxlength="120">

        <label for="idNumber">Your ID number</label>
        <input type="text" id="idNumber" name="idNumber" required inputmode="numeric" maxlength="40">

        <label for="pad">Sign with your finger</label>
        <canvas id="pad"></canvas>
        <div class="row">
          <button type="button" id="clear">Clear signature</button>
        </div>

        <input type="hidden" id="signature" name="signature">
        <p style="margin-top:1.25rem">By signing you agree to the terms above and confirm the declarations are true.</p>
        <button type="submit" id="submit" disabled>Sign contract ${escapeHtml(contract.number)}</button>
      </form>
    </div>
    <script>${SIGNATURE_SCRIPT}</script>`);
}

export function signedPage(contract: Contract, whatsapp: string): string {
  return page(`Contract ${contract.number} signed`, `
    <div class="card">
      <h1>Signed — thank you</h1>
      <p class="meta">${escapeHtml(BUSINESS.tradingAs)} · Contract ${escapeHtml(contract.number)}</p>
      <p class="done">Signed by ${escapeHtml(contract.signed_name ?? '')} on
      ${escapeHtml((contract.signed_at ?? '').slice(0, 10))}.</p>
      <p>Bring your item and documents in to collect ${formatAmount(contract.principal_cents)}. The loan starts
      when you hand the item over, and ${formatAmount(contract.total_due_cents)} is due by
      ${escapeHtml(contract.due_date)}.</p>
      <p class="meta">Questions? WhatsApp ${escapeHtml(whatsapp)}.</p>
    </div>
    <div class="card">${contract.body_html}</div>`);
}

export function contractErrorPage(message: string, whatsapp: string): string {
  return page('Contract unavailable', `
    <div class="card">
      <h1>This link cannot be used</h1>
      <p class="error">${escapeHtml(message)}</p>
      <p class="meta">WhatsApp ${escapeHtml(whatsapp)} and we'll sort it out.</p>
    </div>`);
}
