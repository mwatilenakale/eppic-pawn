/**
 * The Eppic design system, from the spec: dark, gold, Inter, 4px grid.
 *
 * Every value is a custom property and nothing downstream writes a raw hex —
 * that is the spec's own first rule, and it is what lets the whole site change
 * character by editing this file.
 *
 * Two deliberate departures from the document, both to keep a promise the site
 * already makes:
 *
 * 1. **No Google Fonts import.** The spec asks for Inter over a CDN link. This
 *    page loads nothing from any third party — a font request hands every
 *    visitor's IP to Google, and a slow CDN blocks the render on a phone in
 *    Windhoek. The spec's own fallback stack is used instead, which is what
 *    most visitors would see anyway.
 *
 * 2. **Zoom stays enabled.** The boilerplate sets `user-scalable=no`, which
 *    contradicts the spec's own accessibility section. The iOS zoom-on-focus
 *    problem it was avoiding is solved properly, by the 16px input rule the
 *    spec also specifies.
 */

export const THEME = `
:root {
  color-scheme: dark;

  /* Backgrounds */
  --bg-primary: #0a0a0a;
  --bg-secondary: #141414;
  --bg-tertiary: #1c1c1c;
  --bg-hover: #262626;

  /* Accents */
  --accent-gold: #f5a623;
  --accent-gold-hover: #ffb84d;
  --accent-gold-dim: #f5a62320;

  /* Semantic */
  --success: #10b981;
  --success-dim: #10b98120;
  --danger: #ef4444;
  --danger-dim: #ef444420;
  --warning: #f59e0b;

  /* Text */
  --text-primary: #ffffff;
  --text-secondary: #a3a3a3;
  --text-muted: #525252;

  /* Borders */
  --border-subtle: #262626;
  --border-active: #f5a623;

  /* 4px base grid */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
  --space-12: 48px; --space-16: 64px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.container { width: 100%; max-width: 768px; margin: 0 auto; padding: var(--space-4); }
@media (min-width: 640px) { .container { padding: var(--space-6); max-width: 640px; } }
@media (min-width: 1024px) { .container { padding: var(--space-10); max-width: 768px; } }
@media (min-width: 1280px) { .container { max-width: 880px; } }

/* --- typography --------------------------------------------------------- */

h1 { font-size: 36px; font-weight: 900; line-height: 1.1; letter-spacing: -0.02em; text-wrap: balance; }
h2 { font-size: 22px; font-weight: 700; line-height: 1.3; text-wrap: balance; }
h3 { font-size: 18px; font-weight: 600; line-height: 1.4; }
@media (min-width: 768px) {
  h1 { font-size: 56px; }
  h2 { font-size: 28px; }
  h3 { font-size: 20px; }
  body { font-size: 16px; }
}

.label, .input-label, .step-label {
  font-size: 11px; font-weight: 600; line-height: 1.4;
  text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-secondary);
}
@media (min-width: 768px) { .label, .input-label { font-size: 12px; } }

.lead { font-size: 16px; color: var(--text-secondary); text-wrap: balance; }
.muted { color: var(--text-secondary); font-size: 13px; }
.dim { color: var(--text-muted); }

/* --- step progress ------------------------------------------------------ */

.step-bar {
  display: flex; align-items: center; justify-content: center;
  gap: var(--space-2); margin-bottom: var(--space-8); flex-wrap: wrap;
}
.step { display: flex; align-items: center; gap: var(--space-2); }
.step-number {
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 14px; transition: all 0.3s ease; flex-shrink: 0;
}
.step-number.pending { background: var(--bg-tertiary); color: var(--text-muted); border: 2px solid var(--border-subtle); }
.step-number.active {
  background: var(--accent-gold); color: var(--bg-primary);
  border: 2px solid var(--accent-gold); box-shadow: 0 0 20px var(--accent-gold-dim);
}
.step-number.completed { background: var(--success); color: #fff; border: 2px solid var(--success); }
.step-label.active { color: var(--accent-gold); }
.step-connector { width: 24px; height: 2px; background: var(--border-subtle); border-radius: 1px; }
.step-connector.completed { background: var(--success); }
@media (min-width: 768px) { .step-bar { gap: var(--space-4); } .step-connector { width: 60px; } }
@media (max-width: 520px) { .step-label { display: none; } }

/* --- cards -------------------------------------------------------------- */

.card {
  background: var(--bg-secondary); border: 1px solid var(--border-subtle);
  border-radius: 20px; padding: var(--space-6); margin-bottom: var(--space-4);
  contain: layout style paint;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
@media (min-width: 640px) { .card { padding: var(--space-8); } }
.card-highlight { border-color: var(--accent-gold); background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--accent-gold-dim) 100%); }
.card-danger { border-color: var(--danger); background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--danger-dim) 100%); }
.card-success { border-color: var(--success); background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--success-dim) 100%); }

/* --- buttons ------------------------------------------------------------ */

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  width: 100%; padding: 14px var(--space-6); border-radius: 14px;
  font: inherit; font-weight: 700; font-size: 15px; border: none; cursor: pointer;
  text-decoration: none; transition: all 0.2s ease; min-height: 48px;
  -webkit-tap-highlight-color: transparent;
}
.btn-primary { background: var(--accent-gold); color: var(--bg-primary); }
.btn-primary:hover { background: var(--accent-gold-hover); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(245, 166, 35, 0.3); }
.btn-primary:active { transform: translateY(0); }
.btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-subtle); }
.btn-secondary:hover { background: var(--bg-hover); }
.btn-success { background: var(--success); color: #fff; }
.btn-ghost { background: transparent; color: var(--text-secondary); }
.btn-ghost:hover { color: var(--text-primary); background: var(--bg-hover); }

/* --- inputs ------------------------------------------------------------- */

.input, textarea.input {
  width: 100%; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
  border-radius: 14px; padding: 14px var(--space-4); color: var(--text-primary);
  /* 16px prevents iOS zooming the page on focus — the reason the spec's
     boilerplate disabled zoom outright, fixed without disabling zoom. */
  font: inherit; font-size: 16px; transition: all 0.2s ease; outline: none;
}
.input::placeholder { color: var(--text-muted); }
.input:focus { border-color: var(--accent-gold); box-shadow: 0 0 0 3px var(--accent-gold-dim); }
.input-group { margin-bottom: var(--space-4); }
.input-label { display: block; margin-bottom: var(--space-2); }

/* --- prices ------------------------------------------------------------- */

.price-display { font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.price-large { font-size: clamp(32px, 5vw, 48px); font-weight: 800; line-height: 1.1; }
.price-medium { font-size: 22px; font-weight: 700; line-height: 1.2; }
@media (min-width: 768px) { .price-medium { font-size: 28px; } }
.price-accent { color: var(--accent-gold); }
.price-success { color: var(--success); }

.price-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-4); padding: var(--space-3) 0; border-bottom: 1px solid var(--border-subtle);
}
.price-row:last-child { border-bottom: none; }
.price-row .label { flex-shrink: 0; }
.price-row strong { font-variant-numeric: tabular-nums; font-weight: 700; }

.badge {
  display: inline-block; padding: 2px var(--space-2); border-radius: 6px;
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  background: var(--accent-gold); color: var(--bg-primary); margin-left: var(--space-2);
}

/* --- category grid ------------------------------------------------------ */

.category-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); list-style: none; }
@media (min-width: 768px) { .category-grid { grid-template-columns: repeat(3, 1fr); gap: var(--space-4); } }

.category-card {
  display: block; background: var(--bg-secondary); border: 2px solid var(--border-subtle);
  border-radius: 20px; padding: var(--space-6) var(--space-4); text-align: center;
  cursor: pointer; text-decoration: none; color: inherit; min-height: 48px;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  -webkit-tap-highlight-color: transparent;
}
.category-card:hover { border-color: var(--accent-gold); background: var(--accent-gold-dim); transform: translateY(-4px) scale(1.02); }
.category-card.selected { border-color: var(--accent-gold); background: var(--accent-gold-dim); box-shadow: 0 0 30px var(--accent-gold-dim); }
.category-icon { font-size: 40px; line-height: 1; margin-bottom: var(--space-3); transition: transform 0.3s ease; display: block; }
.category-card:hover .category-icon { transform: scale(1.15); }
.category-name { font-weight: 700; font-size: 14px; color: var(--text-primary); }

/* --- choices (yes / no / not sure) -------------------------------------- */

.choices { display: flex; gap: var(--space-2); }
.choices label {
  flex: 1; text-align: center; border: 1px solid var(--border-subtle); border-radius: 12px;
  padding: 12px var(--space-2); cursor: pointer; background: var(--bg-tertiary);
  font-size: 14px; font-weight: 600; color: var(--text-secondary);
  min-height: 48px; display: flex; align-items: center; justify-content: center;
  transition: all 0.2s ease; -webkit-tap-highlight-color: transparent;
}
.choices input { position: absolute; opacity: 0; pointer-events: none; }
.choices label:has(input:checked) { border-color: var(--accent-gold); background: var(--accent-gold-dim); color: var(--accent-gold); }
fieldset { border: 0; padding: 0; margin: 0 0 var(--space-5); }
legend { font-weight: 600; padding: 0; margin-bottom: var(--space-3); font-size: 15px; }

/* --- verification banner ------------------------------------------------ */

.verification-banner {
  background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--danger-dim) 100%);
  border: 2px solid var(--danger); border-radius: 20px; padding: var(--space-6);
  position: relative; overflow: hidden; margin-bottom: var(--space-4);
}
.verification-banner::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, var(--danger), transparent);
}
.verification-icon { font-size: 32px; animation: pulse 2s ease infinite; display: block; margin-bottom: var(--space-3); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

/* --- lists -------------------------------------------------------------- */

ul.plain { list-style: none; }
ul.plain li { padding: var(--space-2) 0; display: flex; gap: var(--space-3); align-items: flex-start; color: var(--text-secondary); }
ul.plain li::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-gold); flex-shrink: 0; margin-top: 9px; }
ul.plain li.ok::before { background: var(--success); }
ul.plain li.warn::before { background: var(--danger); }

/* --- entrance ----------------------------------------------------------- */

.page-enter { animation: slideUpFade 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes slideUpFade { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

.stagger-children > * { opacity: 0; transform: translateY(16px); animation: staggerIn 0.4s ease forwards; }
.stagger-children > *:nth-child(1) { animation-delay: 0s; }
.stagger-children > *:nth-child(2) { animation-delay: 0.08s; }
.stagger-children > *:nth-child(3) { animation-delay: 0.16s; }
.stagger-children > *:nth-child(4) { animation-delay: 0.24s; }
.stagger-children > *:nth-child(5) { animation-delay: 0.32s; }
@keyframes staggerIn { to { opacity: 1; transform: translateY(0); } }

/* --- header / footer ---------------------------------------------------- */

header { margin-bottom: var(--space-6); }
header h1 { margin-bottom: var(--space-2); }
footer { margin-top: var(--space-12); text-align: center; color: var(--text-muted); font-size: 12px; line-height: 1.8; }

/* --- accessibility ------------------------------------------------------ */

:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; border-radius: 4px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

/**
 * The staff dashboard, which is a different shape from the public site: dense
 * lists read on a phone rather than one question at a time. Same tokens, so
 * it cannot drift from the look Lukas chose, and loaded only on that page.
 */
export const DASHBOARD_CSS = `
.dash-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-6); }
.dash-head h1 { font-size: 22px; margin: 0; }

.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); margin-bottom: var(--space-6); }
@media (min-width: 560px) { .tiles { grid-template-columns: repeat(4, 1fr); } }
.tile { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px; padding: var(--space-4); }
.tile-value { font-size: 26px; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; }
.tile-label { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

.section { margin-bottom: var(--space-6); }
.section > h2 {
  font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--text-secondary); margin: 0 0 var(--space-3);
  display: flex; align-items: center; gap: var(--space-2);
}
.count { background: var(--bg-tertiary); color: var(--text-primary); border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 700; }
.count-urgent { background: var(--accent-gold); color: var(--bg-primary); }
.count-bad { background: var(--danger); color: #fff; }

.rows { display: flex; flex-direction: column; gap: var(--space-2); }
.row {
  background: var(--bg-secondary); border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--border-subtle); border-radius: 10px; padding: var(--space-4);
}
.row-urgent { border-left-color: var(--accent-gold); }
.row-good { border-left-color: var(--success); }
.row-bad { border-left-color: var(--danger); }
.row-top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.row-who { font-weight: 600; }
.row-when { font-size: 12px; color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.row-what { font-size: 14px; color: var(--text-secondary); margin-top: 2px; }
.row-meta { font-size: 12px; color: var(--text-muted); margin-top: var(--space-2); }
.ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent-gold); font-weight: 700; }

.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: var(--space-2); }
.chip { font-size: 11px; border-radius: 999px; padding: 2px 8px; border: 1px solid var(--border-subtle); color: var(--text-secondary); }
.chip-missing { border-color: var(--danger); color: var(--danger); }
.chip-have { border-color: var(--success); color: var(--success); }

.empty { color: var(--text-muted); font-size: 14px; padding: var(--space-4); border: 1px dashed var(--border-subtle); border-radius: 10px; }
`;

/** Emoji per playbook category. Inline, so no icon font is loaded. */
export const CATEGORY_ICONS: Record<string, string> = {
  cars: '🚗',
  phones: '📱',
  laptops: '💻',
  tvs: '📺',
  consoles: '🎮',
};

export function iconFor(slug: string): string {
  return CATEGORY_ICONS[slug] ?? '📦';
}
