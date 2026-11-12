// ============================================================================
// The local report viewer's page (specs/aeo-open-source-cli-spec.md §4.3,
// §10, §12), in the hosted report's design language: a pale amber hero with
// the hard-shadow measurement card, then full-width bands that alternate
// white and grey, one per market section. One self-contained document, no
// remote fonts, scripts or images. The server derives every figure
// (presentation.ts); this script only renders it. Every captured or
// model-written string is inserted with textContent, never as markup, and
// source links open only when clicked.
// ============================================================================

const styles = `
:root {
  --darkest: #000; --lightest: #fff; --brand-1: #ffd08a; --brand-1-light: #ffedd2;
  --neutral-1: #f1f1f1; --neutral-2: #c8c8c8; --positive: #059669;
  --positive-deep: #065f46; --mention: #8b5cf6; --mention-deep: #5b21b6;
  --negative: #ef4444; --muted: rgb(0 0 0 / 0.6); --muted-strong: rgb(0 0 0 / 0.7);
  --backdrop: rgb(0 0 0 / 0.25);
  --font-body: Mulish, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "Source Code Pro", ui-monospace, SFMono-Regular, Menlo, monospace;
  /* Light only, as the hosted report is, whatever the system theme. */
  color-scheme: light;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--lightest); color: var(--darkest);
  font: 16px/1.5 var(--font-body); }
p, h1, h2, h3, ul { margin: 0; }
ul { padding: 0; list-style: none; }
button { font: inherit; color: inherit; }
button:not(:disabled) { cursor: pointer; }
:focus-visible { outline: 2px solid var(--darkest); outline-offset: 2px; }
.mono { font-family: var(--font-mono); }
.muted { color: var(--muted); }
.container { width: 100%; max-width: 1280px; margin: 0 auto; padding: 0 20px; }
.band { background: var(--lightest); }
.band.soft { background: var(--neutral-1); }
.band > .container > .band-inner { padding: 60px 0; }
.banner { background: var(--darkest); color: var(--lightest); padding: 12px 20px;
  text-align: center; font-size: 14px; }
.eyebrow { font-family: var(--font-mono); font-size: 14px; line-height: 20px;
  font-weight: 500; text-transform: uppercase; }
.h1 { font-size: 32px; line-height: 37px; font-weight: 900; text-wrap: balance; }
.h2 { font-size: 28px; line-height: 34px; font-weight: 900; text-wrap: balance; }
.h5 { font-size: 18px; line-height: 25px; font-weight: 800; }
.body-1 { font-size: 20px; line-height: 24px; font-weight: 500; }
.body-2 { font-size: 18px; line-height: 22px; font-weight: 500; }
.hero { background: var(--brand-1-light); }
.hero-grid { display: grid; gap: 40px; padding: 40px 0 60px; }
.hero-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 20px; }
.hero-copy .body-1 { max-width: 720px; }
.measured { font-family: var(--font-mono); font-size: 14px; font-weight: 500; color: var(--muted); }
.measurement { border: 1px solid var(--neutral-2); border-radius: 8px; background: var(--lightest);
  padding: 20px; box-shadow: 8px 8px var(--neutral-2); }
.measurement-figure { font-size: 50px; line-height: 56px; font-weight: 900; margin-top: 12px; }
.facts { display: flex; flex-direction: column; gap: 12px; margin-top: 24px; }
.facts li { font-family: var(--font-mono); font-size: 14px; line-height: 20px; font-weight: 500;
  border: 1px solid var(--neutral-2); border-radius: 4px; background: var(--neutral-1); padding: 12px; }
.header { display: grid; gap: 16px; }
.header-title { display: flex; flex-direction: column; gap: 12px; }
.header.center { display: flex; flex-direction: column; align-items: center; text-align: center; }
.header.center .body-2 { max-width: 820px; }
.scorecards { margin-top: 40px; border-radius: 16px; background: var(--brand-1-light); padding: 30px 20px; }
.scorecards-grid { display: grid; grid-template-columns: 1fr; gap: 30px; }
.stat { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.stat-figure { font-family: var(--font-mono); font-size: 40px; line-height: 36px;
  font-variant-numeric: tabular-nums; }
.stat-label { font-size: 16px; font-weight: 700; }
.stat-detail { font-size: 14px; color: var(--muted-strong); }
.interval { display: block; }
.tip-trigger { background: none; border: 0; padding: 0; margin: 0; text-align: left;
  font-size: 14px; color: var(--muted-strong); text-decoration: underline dotted;
  text-underline-offset: 4px; cursor: help; }
.tip { display: block; margin-top: 4px; font-size: 12px; color: var(--muted-strong); }
.tip[hidden] { display: none; }
.subsection { margin-top: 40px; }
.card { margin-top: 20px; border: 1px solid var(--neutral-2); border-radius: 8px;
  background: var(--lightest); padding: 20px; }
.card-title { font-size: 16px; font-weight: 700; }
.card-lead { margin-top: 4px; font-size: 14px; color: var(--muted); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 14px; }
th { font-family: var(--font-mono); font-weight: 500; color: var(--muted); text-align: left;
  border-bottom: 1px solid var(--neutral-2); padding: 8px 12px; }
td { border-bottom: 1px solid var(--neutral-2); padding: 10px 12px; vertical-align: top; }
.num { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.rate { font-weight: 600; font-variant-numeric: tabular-nums; }
tr.total td { border-bottom: 0; font-weight: 700; color: var(--darkest); }
tr.selectable { cursor: pointer; }
tr.selectable:hover { background: var(--neutral-1); }
.row-button { background: none; border: 0; padding: 0; text-align: left; }
.matrix-card { margin-top: 40px; padding: 16px; }
.matrix { min-width: 640px; }
.matrix th, .matrix td { text-align: center; padding: 8px 12px; }
.matrix th.prompt-head, .matrix td.prompt { text-align: left; position: sticky; left: 0;
  z-index: 1; background: var(--lightest); }
.matrix td.prompt { max-width: 280px; }
.matrix .group { border-bottom: 0; padding-bottom: 4px; font-size: 11px; letter-spacing: 0.05em;
  text-transform: uppercase; }
.matrix .agents-start { border-left: 1px solid var(--neutral-2); }
.prompt-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; font-size: 12px; line-height: 1.375; }
.prompt-category { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.05em;
  text-transform: uppercase; color: var(--muted); }
.cell { display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; min-width: 36px; min-height: 36px; padding: 4px 6px; border: 1px solid transparent;
  border-radius: 6px; background: none; }
.cell:hover { border-color: var(--neutral-2); background: var(--neutral-1); }
.cell-count { font-size: 9px; line-height: 1; color: var(--muted); font-variant-numeric: tabular-nums; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--neutral-2); }
.dot.primary { width: 10px; height: 10px; background: var(--positive); }
.dot.mentioned { background: var(--mention); }
.dot.absent { background: var(--negative); opacity: 0.7; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 20px; margin-top: 12px; font-size: 11px; color: var(--muted); }
.legend li { display: flex; align-items: center; gap: 8px; }
.hint { margin-top: 12px; border: 1px solid var(--brand-1); border-radius: 6px;
  background: var(--brand-1-light); padding: 8px 12px; font-size: 12px; line-height: 1.625; }
.bars { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.bars li { display: grid; grid-template-columns: minmax(0, 11rem) 1fr auto; align-items: center; gap: 12px; }
.bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; }
.bar-domain { margin-left: 6px; font-size: 12px; font-weight: 400; color: var(--muted); }
.bar { height: 6px; overflow: hidden; border-radius: 999px; background: var(--neutral-1); }
.bar-fill { display: block; height: 100%; border-radius: 999px; background: var(--darkest); }
.bar-value { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.hosts { margin-left: 8px; font-size: 12px; color: var(--muted); }
.more { margin-top: 12px; background: none; border: 0; padding: 0; font-family: var(--font-mono);
  font-size: 12px; text-decoration: underline; text-decoration-color: var(--brand-1);
  text-decoration-thickness: 2px; text-underline-offset: 4px; }
.label { font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--muted); }
.pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--neutral-2);
  border-radius: 999px; background: var(--neutral-1); padding: 4px 10px; font-size: 12px; }
.pill.plain { background: var(--lightest); }
.pill.dashed { border-style: dashed; background: none; color: var(--muted); }
.pill.mono { font-family: var(--font-mono); }
.pill.pass, .pill.primary { border-color: rgb(5 150 105 / 0.3); background: rgb(5 150 105 / 0.1);
  color: var(--positive-deep); font-weight: 500; }
.pill.mentioned { border-color: rgb(139 92 246 / 0.3); background: rgb(139 92 246 / 0.1);
  color: var(--mention-deep); font-weight: 500; }
.pill.fail, .pill.absent { border-color: rgb(239 68 68 / 0.2); background: rgb(239 68 68 / 0.1);
  font-weight: 500; }
.pill-count { color: var(--muted); font-variant-numeric: tabular-nums; }
.verification td:nth-child(2) { white-space: nowrap; }
.footer { max-width: 720px; margin: 0 auto; text-align: center; font-size: 14px;
  line-height: 1.625; color: var(--muted); }
.footer > * + * { margin-top: 12px; }
.footer h2 { margin-top: 24px; font-size: 14px; font-weight: 700; color: var(--muted-strong); }
.footer ul { margin-top: 8px; padding-left: 20px; list-style: disc; text-align: left; }
.footer ul li + li { margin-top: 4px; }
.footer-note { margin-top: 32px; border-top: 1px solid var(--neutral-2); padding-top: 24px; }
.sheet-backdrop { position: fixed; inset: 0; z-index: 1000; background: var(--backdrop); cursor: pointer; }
.sheet { position: fixed; top: 0; right: 0; bottom: 0; z-index: 1001; display: flex;
  flex-direction: column; width: 100%; max-width: 560px; background: var(--lightest);
  padding: 20px; box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1); }
.sheet[hidden], .sheet-backdrop[hidden] { display: none; }
.sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.sheet-description { margin-top: 4px; font-size: 14px; color: var(--muted); }
.sheet-close { flex-shrink: 0; border: 1px solid var(--neutral-2); border-radius: 6px;
  background: none; padding: 4px 10px; font-family: var(--font-mono); font-size: 14px; }
.sheet-close:hover { background: var(--neutral-1); }
.sheet-body { display: flex; flex-direction: column; gap: 20px; flex: 1; min-height: 0;
  margin-top: 20px; padding-right: 4px; overflow-y: auto; }
.prompt-box { border: 1px solid var(--neutral-2); border-radius: 8px; background: var(--neutral-1); padding: 16px; }
.prompt-box p { margin-top: 8px; font-size: 14px; line-height: 1.625; }
.prompt-box p.prompt-category { font-size: 11px; letter-spacing: 0.14em; }
.run { border: 1px solid var(--neutral-2); border-radius: 8px; background: var(--lightest); padding: 16px; }
.run-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.run-head .pills { margin-top: 0; justify-content: flex-end; }
.run-title { font-size: 14px; font-weight: 700; }
.run-surface { font-size: 12px; color: var(--muted); }
.run-block { margin-top: 16px; }
.snippet { margin-top: 16px; border-radius: 6px; background: var(--neutral-1); padding: 12px; }
.answer { margin-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.625; }
.answer mark { background: var(--brand-1-light); color: inherit; border-radius: 2px;
  box-shadow: 0 0 0 1px var(--brand-1); }
.links { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.source { max-width: 100%; background: none; border: 0; padding: 0; text-align: left;
  overflow-wrap: anywhere; font-size: 12px; font-weight: 500; text-decoration: underline;
  text-decoration-color: var(--brand-1); text-decoration-thickness: 2px; text-underline-offset: 4px; }
.source:hover { text-decoration-color: var(--darkest); }
.source-meta { margin-top: 2px; font-size: 11px; color: var(--muted); }
.empty { border: 1px dashed var(--neutral-2); border-radius: 6px; padding: 12px; font-size: 14px; color: var(--muted); }
@media (min-width: 480px) {
  .h1 { font-size: 40px; line-height: 50px; }
  .h2 { font-size: 32px; line-height: 38px; }
  .scorecards-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sheet { padding: 32px; }
}
@media (min-width: 768px) {
  .container { padding: 0 30px; }
  .h1 { font-size: 44px; line-height: 56px; }
  .h2 { font-size: 36px; line-height: 42px; }
  .h5 { font-size: 20px; }
  .body-1 { font-size: 22px; line-height: 28px; }
  .body-2 { font-size: 20px; line-height: 25px; }
  .hero-grid { padding-top: 80px; }
  .measurement { padding: 30px; }
  .header.split { grid-template-columns: 0.8fr 1fr; align-items: start; gap: 40px; }
  .scorecards { padding: 30px 40px; }
  .scorecards-grid { gap: 40px; }
  .matrix-card { padding: 20px; }
}
@media (min-width: 992px) {
  .container { padding: 0 40px; }
  .band > .container > .band-inner { padding: 100px 0; }
  .eyebrow { font-size: 16px; }
  .h2 { font-size: 42px; line-height: 50px; }
  .body-1 { font-size: 24px; line-height: 30px; }
  .hero-grid { grid-template-columns: minmax(0, 1fr) minmax(340px, 0.62fr); align-items: center;
    padding: 100px 0; }
  .measurement-figure { font-size: 72px; line-height: 78px; }
  .facts li { font-size: 16px; }
  .scorecards { padding: 40px 60px; }
  .scorecards-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .scorecards-grid.five { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .stat-figure { font-size: 56px; line-height: 48px; }
}
@media (min-width: 1280px) {
  .scorecards-grid.five { grid-template-columns: repeat(5, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto; transition: none; }
}
`;

const script = `
const token = new URLSearchParams(location.search).get('t');
const get = async (path) => {
  const response = await fetch('/data/' + path + '?t=' + encodeURIComponent(token));
  if (!response.ok) return null;
  return response.json();
};
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};
const plural = (count, noun) => count + ' ' + noun + (count === 1 ? '' : 's');

// Escape closes whatever is open: a tooltip, or the evidence sheet.
const dismissals = [];
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') for (const dismiss of dismissals) dismiss();
});

// The counts behind an interval, in a tooltip (WCAG 1.4.13). It opens on
// hover, on keyboard focus and on a tap; it stays open while the pointer is
// over it; Escape closes it; and a screen reader reads it as the interval's
// description. It sits in the flow under the interval, so a scrolling table
// cannot clip it and it hides nothing.
let tipCount = 0;
const intervalOf = (interval) => {
  if (!interval) return null;
  tipCount += 1;
  const id = 'tip-' + tipCount;
  const tip = el('span', { class: 'tip', role: 'tooltip', id, hidden: '' }, interval.counts);
  let hovered = false;
  let focused = false;
  const sync = () => {
    if (hovered || focused) tip.removeAttribute('hidden');
    else tip.setAttribute('hidden', '');
  };
  const trigger = el('button', { type: 'button', class: 'tip-trigger',
    'aria-label': interval.label, 'aria-describedby': id,
    // Safari focuses no button on a click or a tap, and a button that kept
    // focus through Escape gets no new focus event: a click (or Enter or
    // Space) opens the tip itself, until focus moves on.
    onclick: () => { trigger.focus(); focused = true; sync(); },
    onfocus: () => { focused = true; sync(); },
    onblur: () => { focused = false; sync(); },
  }, interval.text);
  dismissals.push(() => { hovered = false; focused = false; sync(); });
  return el('span', { class: 'interval',
    onmouseenter: () => { hovered = true; sync(); },
    onmouseleave: () => { hovered = false; sync(); },
  }, trigger, tip);
};

// External sources open only on a deliberate click, in a new context.
const sourceLink = (url) => el('button', { class: 'source', type: 'button',
  onclick: () => { if (/^https?:\\/\\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
}, url);

// The brand's name marked in a captured answer, every piece of it text.
const highlighted = (text, term) => {
  const needle = term.trim().toLowerCase();
  if (!needle) return [text];
  const haystack = text.toLowerCase();
  const pieces = [];
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    pieces.push(text.slice(from, at), el('mark', {}, text.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  pieces.push(text.slice(from));
  return pieces.filter((piece) => piece !== '');
};

// The side sheet behind a matrix cell or a cited domain.
const createSheet = () => {
  const title = el('h2', { class: 'h5', id: 'sheet-title' });
  const description = el('p', { class: 'sheet-description' });
  const body = el('div', { class: 'sheet-body' });
  let opener = null;
  let isOpen = false;
  const backdrop = el('div', { class: 'sheet-backdrop', hidden: '', onclick: () => close() });
  const closeButton = el('button', { type: 'button', class: 'sheet-close', onclick: () => close() }, 'Close');
  const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'sheet-title', hidden: '' },
    el('div', { class: 'sheet-head' }, el('div', {}, title, description), closeButton), body);
  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    backdrop.setAttribute('hidden', '');
    panel.setAttribute('hidden', '');
    // Focus returns to what opened the sheet.
    opener?.focus();
  };
  dismissals.push(close);
  const open = (from, heading, summary, content) => {
    opener = from;
    title.replaceChildren(heading);
    description.replaceChildren(summary);
    body.replaceChildren(...content);
    backdrop.removeAttribute('hidden');
    panel.removeAttribute('hidden');
    isOpen = true;
    closeButton.focus();
  };
  return { nodes: [backdrop, panel], open };
};

const band = (tone, ...content) => el('section', { class: tone === 'soft' ? 'band soft' : 'band' },
  el('div', { class: 'container' }, el('div', { class: 'band-inner' }, ...content)));

const sectionHeader = (eyebrow, heading, lead, layout) => {
  const title = el('div', { class: 'header-title' },
    el('p', { class: 'eyebrow' }, eyebrow), el('h2', { class: 'h2' }, heading));
  return el('div', { class: 'header ' + (layout || (lead ? 'split' : '')) },
    title, lead ? el('p', { class: 'body-2' }, lead) : null);
};

const statusLabels = { primary: 'Primary', mentioned: 'Mentioned', absent: 'Absent', no_overview: 'No AI Overview' };
const retrievalLabels = { searched: 'searched the web', memory: 'answered from memory', unknown: 'retrieval unknown' };

const runCard = (run, brandName) => el('article', { class: 'run' },
  el('div', { class: 'run-head' },
    el('div', {}, el('p', { class: 'run-title' }, 'Run ' + run.runNumber),
      el('p', { class: 'run-surface' }, run.surface + (run.cliVersion ? ' · ' + run.cliVersion : ''))),
    el('div', { class: 'pills' },
      run.retrieval ? el('span', { class: 'pill mono' + (run.retrieval === 'unknown' ? ' dashed' : '') },
        retrievalLabels[run.retrieval]) : null,
      el('span', { class: 'pill ' + (run.status === 'no_overview' ? 'dashed' : run.status) }, statusLabels[run.status]))),
  run.snippet ? el('div', { class: 'snippet' }, el('p', { class: 'label' }, 'Detected mention'),
    el('p', { class: 'answer' }, ...highlighted(run.snippet, brandName))) : null,
  run.answer ? el('div', { class: 'run-block' }, el('p', { class: 'label' }, 'Full captured answer'),
    el('p', { class: 'answer' }, ...highlighted(run.answer, brandName)))
    : el('p', { class: 'empty run-block' }, run.status === 'no_overview'
      ? 'The results page showed no AI Overview: there is no answer to show.'
      : 'No captured answer in this bundle matches this run.'),
  run.mentionedBrands.length ? el('div', { class: 'run-block' }, el('p', { class: 'label' }, 'Mentioned companies'),
    el('ul', { class: 'pills' }, run.mentionedBrands.map((brand) => el('li', {}, el('span', { class: 'pill plain' }, brand))))) : null,
  run.citedUrls.length ? el('div', { class: 'run-block' }, el('p', { class: 'label' }, 'URLs in response'),
    el('ul', { class: 'links' }, run.citedUrls.map((url) => el('li', {}, sourceLink(url))))) : null,
);

const scorecards = (cards) => el('div', { class: 'scorecards' },
  el('div', { class: cards.length >= 5 ? 'scorecards-grid five' : 'scorecards-grid' },
    cards.map((card) => el('div', { class: 'stat' },
      el('p', { class: 'stat-figure' }, card.headline),
      intervalOf(card.headlineInterval),
      el('p', { class: 'stat-label' }, card.label),
      card.detail ? el('p', { class: 'stat-detail' }, card.detail) : null,
      intervalOf(card.detailInterval)))));

const surfaceRates = (rows) => rows.length === 0 ? null : el('section', { class: 'subsection', 'aria-label': 'Rates by AI surface' },
  el('p', { class: 'h5' }, 'By AI surface'),
  el('div', { class: 'scroll' }, el('table', { class: 'by-model' },
    el('thead', {}, el('tr', {}, el('th', {}, 'AI surface'), el('th', {}, 'Share of voice'), el('th', {}, 'Citation rate'))),
    el('tbody', {}, rows.map((row) => el('tr', {},
      el('td', {}, row.surface),
      el('td', {}, el('span', { class: 'rate' }, row.shareOfVoice.percent), intervalOf(row.shareOfVoice.interval)),
      el('td', {}, el('span', { class: 'rate' }, row.citationRate.percent), intervalOf(row.citationRate.interval))))))));

const dot = (status) => el('span', { class: 'dot ' + status, role: 'img',
  'aria-label': { primary: 'Primary mention', mentioned: 'Secondary mention', absent: 'Not mentioned', no_data: 'No data' }[status] });

const matrix = (section, brandName, sheet) => {
  const { assistantSurfaces, agentSurfaces, rows } = section.matrix;
  const surfaces = [...assistantSurfaces, ...agentSurfaces];
  const firstAgent = assistantSurfaces.length;
  const edge = (index, base) => base + (agentSurfaces.length && index === firstAgent ? ' agents-start' : '');
  const groups = agentSurfaces.length === 0 ? null : el('tr', {},
    el('td', { class: 'prompt group', 'aria-hidden': 'true' }),
    assistantSurfaces.length ? el('th', { class: 'group', colspan: String(assistantSurfaces.length), scope: 'colgroup' }, 'AI assistants') : null,
    el('th', { class: 'group agents-start', colspan: String(agentSurfaces.length), scope: 'colgroup' }, 'Coding agents'));
  const body = rows.map((row, promptIdx) => el('tr', {},
    el('td', { class: 'prompt', title: row.prompt },
      el('span', { class: 'prompt-text' }, row.prompt), el('span', { class: 'prompt-category' }, row.category)),
    row.cells.map((cell, index) => el('td', { class: edge(index, '') },
      cell.status === 'no_data' ? dot('no_data') : (() => {
        const button = el('button', { type: 'button', class: 'cell',
          'aria-label': surfaces[index] + ', prompt ' + (promptIdx + 1) + ': ' + cell.status + '. Inspect evidence.',
          onclick: () => sheet.open(button, surfaces[index] + ' evidence',
            'Prompt ' + (promptIdx + 1) + ' · ' + cell.mentioned + '/' + cell.runs.length + ' runs mentioned ' + brandName,
            [el('section', { class: 'prompt-box' }, el('h3', { class: 'label' }, 'Prompt'), el('p', {}, row.prompt),
              el('p', { class: 'prompt-category' }, row.category)),
             ...cell.runs.map((run) => runCard(run, brandName))]),
        }, dot(cell.status), el('span', { class: 'cell-count' }, cell.mentioned + '/' + cell.runs.length));
        return button;
      })()))));
  return el('div', { class: 'card matrix-card' },
    el('div', { class: 'scroll', role: 'group', 'aria-label': 'AI answer evidence matrix', tabindex: '0' },
      el('table', { class: 'matrix' },
        el('thead', {}, groups, el('tr', {}, el('th', { class: 'prompt-head' }, 'Prompt'),
          surfaces.map((surface, index) => el('th', { class: edge(index, '') }, surface)))),
        el('tbody', {}, body))),
    el('ul', { class: 'legend' },
      [['primary', 'Primary recommendation'], ['mentioned', 'Mentioned secondarily'], ['absent', 'Not mentioned'], ['no_data', 'No data']]
        .map(([status, text]) => el('li', {}, el('span', { class: 'dot ' + status }), text))),
    el('p', { class: 'hint' }, 'Click any dot with a run count to inspect the captured AI answers, cited URLs, and highlighted mentions behind that result.'));
};

const alternatives = (rows) => rows.length === 0 ? null : el('div', { class: 'card' },
  el('h3', { class: 'card-title' }, 'Who buyers hear about instead'),
  el('p', { class: 'card-lead' }, 'Competing companies and products named in the answers, ranked by share of voice (answers that mention them / answers captured).'),
  el('ul', { class: 'bars' }, rows.map((row) => {
    const fill = el('span', { class: 'bar-fill' });
    // CSSOM, which the page's Content Security Policy allows, unlike a style attribute.
    if (fill.style) fill.style.width = (row.share * 100) + '%';
    return el('li', {},
      el('span', { class: 'bar-name', title: row.domain || row.name }, row.name,
        row.domain && row.domain.toLowerCase() !== row.name.trim().toLowerCase() ? el('span', { class: 'bar-domain' }, row.domain) : null),
      el('span', { class: 'bar' }, fill),
      el('span', { class: 'bar-value' }, row.percent + ' ' + row.mentioning + '/' + row.captured));
  })));

const citedDomains = (domains, sheet) => {
  const total = domains.reduce((sum, domain) => sum + domain.count, 0);
  const shown = 10;
  const body = el('tbody');
  const more = el('button', { type: 'button', class: 'more' });
  let showAll = false;
  const rowOf = (domain) => {
    const inspect = (from) => sheet.open(from, domain.domain, plural(domain.count, 'citation') + ' across the captured answers',
      [el('ul', { class: 'links' }, domain.urls.map((url) => el('li', {}, sourceLink(url.url),
        el('p', { class: 'source-meta' }, plural(url.count, 'citation') + ' · ' + url.surfaces.join(', ')),
        ...url.prompts.map((prompt) => el('p', { class: 'source-meta' }, prompt)))))]);
    const name = el('span', { class: domain.isBrand ? 'rate' : '' }, domain.domain);
    const hosts = domain.hosts ? el('span', { class: 'hosts' }, domain.hosts.map((host) => host.label + ' ' + host.count).join(' · ')) : null;
    if (domain.count === 0) return el('tr', {}, el('td', {}, name, hosts), el('td', { class: 'num' }, '0'));
    const button = el('button', { type: 'button', class: 'row-button',
      'aria-label': 'Inspect the ' + domain.count + ' cited URLs behind ' + domain.domain,
      onclick: (event) => { event.stopPropagation?.(); inspect(button); } }, name, hosts);
    return el('tr', { class: 'selectable', onclick: () => inspect(button) },
      el('td', {}, button), el('td', { class: 'num' }, String(domain.count)));
  };
  const sync = () => {
    body.replaceChildren(...(showAll ? domains : domains.slice(0, shown)).map(rowOf));
    const hidden = domains.length - shown;
    more.replaceChildren(showAll ? 'Show fewer domains' : '+' + plural(hidden, 'more domain'));
    if (hidden > 0) more.removeAttribute('hidden'); else more.setAttribute('hidden', '');
  };
  more.addEventListener('click', () => { showAll = !showAll; sync(); });
  sync();
  return el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'What gets cited'),
    el('p', { class: 'card-lead' }, 'Domains behind the URLs cited in these answers'
      + (total > 0 ? ' (' + total + ' citations captured). Click a domain to inspect the URLs behind it.' : '.')),
    el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Domain'), el('th', { class: 'num' }, 'Citations'))), body)),
    more);
};

const sourceCategories = [['owned', 'Owned'], ['competitor', 'Competitor'], ['social', 'Social & community'],
  ['institutional', 'Institutional'], ['earned', 'Earned']];

const sourceMix = (mix) => !mix || mix.rows.length === 0 ? null : el('div', { class: 'card' },
  el('h3', { class: 'card-title' }, 'Where the citations come from'),
  el('p', { class: 'card-lead' }, 'Every cited URL classified: the brand’s own pages, competitor pages, social and community threads, institutional references, or earned media. Each surface leans differently.'),
  el('div', { class: 'scroll', role: 'group', 'aria-label': 'Citation sources by AI surface', tabindex: '0' },
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Surface'), sourceCategories.map(([, label]) => el('th', { class: 'num' }, label)))),
      el('tbody', {},
        mix.rows.map((row) => el('tr', {}, el('td', { class: 'rate' }, row.surface),
          sourceCategories.map(([key]) => el('td', { class: 'num' }, row.counts[key] ? String(row.counts[key]) : '—')))),
        el('tr', { class: 'total' }, el('td', {}, 'All surfaces'),
          sourceCategories.map(([key]) => el('td', { class: 'num' }, mix.total[key] ? String(mix.total[key]) : '—')))))));

const perception = (view, brandName) => {
  if (!view) return null;
  const mentions = view.positive + view.neutral + view.negative;
  if (mentions === 0 && view.phrases.length === 0) return null;
  return el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'How the answers talk about ' + brandName),
    mentions > 0 ? el('p', { class: 'card-lead' }, 'Across ' + mentions + ' answers that mention ' + brandName + ': '
      + view.positive + ' positive, ' + view.neutral + ' neutral, ' + view.negative + ' negative.') : null,
    view.phrases.length ? el('div', { class: 'run-block' },
      el('p', { class: 'label' }, 'Phrases the answers attach to ' + brandName),
      el('ul', { class: 'pills' }, view.phrases.map((phrase) => el('li', {},
        el('span', { class: 'pill', title: 'Said by ' + phrase.surfaces.join(', ') },
          el('span', {}, '“' + phrase.text + '”'),
          phrase.count > 1 ? el('span', { class: 'pill-count' }, '×' + phrase.count) : null))))) : null);
};

const verification = (result) => el('div', { class: 'card' },
  el('h3', { class: 'card-title' }, 'Checks'),
  el('p', { class: 'card-lead' }, 'Capture authenticity: self-reported. Checks run on this machine, offline.'),
  el('div', { class: 'scroll' }, el('table', { class: 'verification' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Check'), el('th', {}, 'Outcome'), el('th', {}, 'Why'))),
    el('tbody', {}, result.checks.map((check) => el('tr', {},
      el('td', {}, check.title),
      el('td', {}, el('span', { class: 'pill ' + (check.outcome === 'pass' ? 'pass' : check.outcome === 'fail' ? 'fail' : 'dashed') },
        check.outcome.replace('_', ' '))),
      el('td', { class: 'muted' }, check.outcome === 'pass' ? '' : check.explanation)))))));

const hero = (report, info) => el('section', { class: 'hero' }, el('div', { class: 'container' },
  el('div', { class: 'hero-grid' },
    el('div', { class: 'hero-copy' },
      el('p', { class: 'eyebrow' }, 'AI visibility audit'),
      el('h1', { class: 'h1' }, report.hero.title),
      el('p', { class: 'body-1' }, report.hero.subtitle),
      el('p', { class: 'measured' }, 'Measured ' + report.hero.measuredOn + ' · ' + info.originLabel)),
    el('div', { class: 'measurement' },
      el('p', { class: 'eyebrow' }, 'The measurement'),
      el('p', { class: 'measurement-figure' }, String(report.hero.probeCount)),
      el('p', { class: 'h5' }, 'captured AI answers'),
      el('ul', { class: 'facts' }, report.hero.facts.map((fact) => el('li', {}, fact)))))));

const plainHero = (info) => el('section', { class: 'hero' }, el('div', { class: 'container' },
  el('div', { class: 'hero-grid' }, el('div', { class: 'hero-copy' },
    el('p', { class: 'eyebrow' }, 'Literally.dev AEO'),
    el('h1', { class: 'h1' }, 'AI visibility audit'),
    el('p', { class: 'measured' }, info.originLabel)))));

const render = async () => {
  const root = document.getElementById('app');
  const [info, result, report] = await Promise.all([get('__viewer'), get('__verification'), get('__report')]);
  root.replaceChildren();
  if (!info || !report) {
    root.append(el('p', { class: 'container' }, 'This viewer link is not valid. Start it again with literally-aeo view.'));
    return;
  }
  const sheet = createSheet();
  const shown = report.outcome === 'shown';
  if (info.workingState) {
    root.append(el('div', { class: 'banner' },
      'Working state, not a finalized revision: this is not an integrity receipt. Export the run to finalize it.'));
  }
  root.append(shown ? hero(report, info) : plainHero(info));
  const bands = [];
  if (shown && report.intro) {
    bands.push([sectionHeader('AI search visibility', report.intro.heading, report.intro.lead, 'center')]);
  }
  if (result || !shown) {
    // A working state is not verified: no claim that it was.
    bands.push([sectionHeader('Evidence', 'Verification', result
      ? 'The bundle re-checked on this machine: its hashes, its event chain and every metric recomputed from its own judgments. A check that cannot run says so.'
      : undefined),
      result ? verification(result) : null,
      shown ? null : el('p', { class: 'card empty' }, report.outcome === 'missing'
        ? 'This run has no report yet: the measurement did not finish.'
        : 'The report cannot be shown: ' + report.reason)]);
  }
  for (const section of shown ? report.sections : []) {
    bands.push([
      sectionHeader('AI search visibility', section.title),
      scorecards(section.scorecards),
      surfaceRates(section.surfaceRates),
      matrix(section, report.brand.name, sheet),
      alternatives(section.alternatives),
      citedDomains(section.citedDomains, sheet),
      sourceMix(section.sourceMix),
      perception(section.perception, report.brand.name),
    ]);
  }
  bands.push([el('div', { class: 'footer' },
    shown ? el('p', {}, report.footer.baseline) : null,
    shown && report.footer.methodology.length ? el('section', { 'aria-labelledby': 'methodology' },
      el('h2', { id: 'methodology' }, 'Methodology'),
      el('ul', { class: 'methodology' }, report.footer.methodology.map((sentence) => el('li', {}, sentence)))) : null,
    ...(shown ? report.footer.notes : []).map((note) => el('p', {}, note)),
    el('p', { class: 'footer-note' },
      'Generated with Literally.dev AEO ' + info.toolVersion + ', an open-source AI visibility audit tool. '
        + info.originLabel + '. Literally.dev did not review this result. Bundle: ' + info.source + '.'))]);
  bands.forEach((content, index) => root.append(band(index % 2 === 1 ? 'soft' : 'plain', ...content)));
  root.append(...sheet.nodes);
};

render().catch((error) => {
  document.getElementById('app').textContent = 'The viewer could not load this bundle: ' + error.message;
});
`;

/** The hosted report's two typefaces, shipped unmodified under the SIL Open
 * Font License (src/viewer/fonts) and served by the viewer itself. */
export const viewerFontFiles = {
  body: 'Mulish-VariableFont_wght.ttf',
  mono: 'SourceCodePro-VariableFont_wght.ttf',
} as const;

const fontFaces = (token: string): string => {
  const source = (file: string) =>
    `url("/fonts/${file}?t=${encodeURIComponent(token)}") format("truetype")`;

  return `
@font-face { font-family: Mulish; font-weight: 200 1000; font-display: swap;
  src: ${source(viewerFontFiles.body)}; }
@font-face { font-family: "Source Code Pro"; font-weight: 200 900; font-display: swap;
  src: ${source(viewerFontFiles.mono)}; }
`;
};

/** viewerPage is the document served at /, bound to one launch's nonce. The
 * launch token, when the viewer serves fonts, is what their URLs carry. */
export const viewerPage = (nonce: string, fontToken?: string): string => {
  const faces = fontToken === undefined ? '' : fontFaces(fontToken);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Literally.dev AEO</title>
<style nonce="${nonce}">${faces}${styles}</style>
</head>
<body>
<main id="app"><p class="container">Loading the audit…</p></main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
};
