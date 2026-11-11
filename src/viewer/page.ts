// ============================================================================
// The local report viewer's page (specs/aeo-open-source-cli-spec.md §4.3,
// §10, §12): one self-contained document, no remote fonts, scripts or
// images. Every captured or model-written string is inserted with
// textContent, never as markup, and source links open only when clicked.
// The script reads bundle files through the launch token it was served with.
// ============================================================================

const styles = `
:root {
  --bg: #ffffff; --fg: #16181d; --muted: #5d6470; --line: #e3e6eb;
  --panel: #f6f7f9; --accent: #3651d4; --pass: #1f7a46; --fail: #b3261e;
  --warn: #8a5a00;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111317; --fg: #e8eaee; --muted: #9aa1ad; --line: #2a2e36;
    --panel: #181b21; --accent: #8fa2ff; --pass: #5fd08f; --fail: #ff8a80;
    --warn: #e5b45a;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 12px; }
h3 { font-size: 15px; margin: 20px 0 8px; }
.muted { color: var(--muted); }
.banner { border: 1px solid var(--line); background: var(--panel);
  padding: 12px 14px; border-radius: 8px; margin: 16px 0; }
.banner.warn { border-color: var(--warn); }
.grid { display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
.stat { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.stat b { display: block; font-size: 22px; }
.interval { display: block; color: var(--muted); font-size: 13px; }
button.tip-trigger { background: none; border: 0; padding: 0; color: inherit; font: inherit;
  text-align: left; cursor: help; text-decoration: underline dotted; text-underline-offset: 3px; }
button.tip-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tip { display: block; color: var(--fg); }
.tip[hidden] { display: none; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line);
  vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
tr.row { cursor: pointer; }
tr.row:hover, tr.row:focus { background: var(--panel); outline: none; }
.pass { color: var(--pass); } .fail { color: var(--fail); }
.limited { color: var(--warn); }
.drawer { border: 1px solid var(--line); border-radius: 8px; padding: 14px;
  margin-top: 12px; background: var(--panel); }
pre { white-space: pre-wrap; word-break: break-word; font: 13px/1.5 ui-monospace,
  SFMono-Regular, Menlo, monospace; margin: 8px 0 0; }
button.link { background: none; border: 0; color: var(--accent); padding: 0;
  font: inherit; cursor: pointer; text-decoration: underline; }
.table-wrap { overflow-x: auto; }
ul.methodology { padding-left: 20px; color: var(--muted); font-size: 14px; }
ul.methodology li { margin: 6px 0; }
footer { margin-top: 48px; color: var(--muted); font-size: 13px; }
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
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};
const percent = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) + '%' : 'n/a';
const isShare = (value) => typeof value === 'number' && value >= 0 && value <= 1;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
// The evidence beside a rate (calculation version 2), or null when the
// bundle has none or it is malformed: a bundle is shown even when it fails
// verification, so its numbers are checked before they are displayed.
const evidenceOf = (evidence) =>
  evidence && isShare(evidence.low) && isShare(evidence.high) && evidence.low <= evidence.high
    && isCount(evidence.count) && isCount(evidence.captured) && isCount(evidence.planned)
    ? evidence : null;
// Outward to whole percents, so the range shown always contains the computed
// interval. The bounds are stored to 6 decimals; scaling them to an integer
// first keeps a bound of 0.07 (7.000000000000001 once multiplied) at 7%.
// The rule of report/core/rate-interval.ts, repeated here because this page
// is one self-contained script; page.spec.ts holds the two to the same
// answers.
const intervalText = (evidence) =>
  Math.floor(Math.round(evidence.low * 1e6) / 1e4) + '–'
    + Math.ceil(Math.round(evidence.high * 1e6) / 1e4) + '%';
// The counts behind an interval, in a tooltip (WCAG 1.4.13). It opens on
// hover, on keyboard focus and on a tap; it stays open while the pointer is
// over it; Escape closes it; and a screen reader reads it as the interval's
// description. It sits in the flow under the interval, so a scrolling table
// cannot clip it and it hides nothing.
const tipDismissals = [];
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') for (const dismiss of tipDismissals) dismiss();
});
let tipCount = 0;
const withTip = (label, name, text) => {
  tipCount += 1;
  const id = 'tip-' + tipCount;
  const tip = el('span', { class: 'tip', role: 'tooltip', id, hidden: '' }, text);
  let hovered = false;
  let focused = false;
  const sync = () => {
    if (hovered || focused) tip.removeAttribute('hidden');
    else tip.setAttribute('hidden', '');
  };
  const trigger = el('button', { type: 'button', class: 'tip-trigger',
    'aria-label': name, 'aria-describedby': id,
    // Safari focuses no button on a click or a tap, and a button that kept
    // focus through Escape gets no new focus event: a click (or Enter or
    // Space) opens the tip itself, until focus moves on.
    onclick: () => { trigger.focus(); focused = true; sync(); },
    onfocus: () => { focused = true; sync(); },
    onblur: () => { focused = false; sync(); },
  }, label);
  tipDismissals.push(() => { hovered = false; focused = false; sync(); });
  return el('span', { class: 'interval',
    onmouseenter: () => { hovered = true; sync(); },
    onmouseleave: () => { hovered = false; sync(); },
  }, trigger, tip);
};
// A rate, with its interval and counts beneath when the bundle carries them.
// subject names the rate for a screen reader, which reaches the interval
// without the label or the column heading beside it.
const rateFigure = (rate, recorded, subject, counted) => {
  const figure = el('b', {}, percent(rate));
  const evidence = evidenceOf(recorded);
  if (!evidence) return [figure];
  const interval = 'approx. 95% interval ' + intervalText(evidence);
  return [figure, withTip(interval, interval + ' for ' + subject,
    counted + ' in ' + evidence.count + ' of ' + evidence.planned + ' planned answers; '
      + evidence.captured + ' captured')];
};
const rateStat = (label, rate, recorded, counted) =>
  el('div', { class: 'stat' }, ...rateFigure(rate, recorded, label.toLowerCase(), counted), label);
// Every surface that ran, each with its own pair of rates.
const modelTable = (byModel, labelOf) => {
  const rows = Object.entries(byModel && typeof byModel === 'object' ? byModel : {})
    .map(([surface, rates]) => {
      const { shareOfVoice, citationRate, shareOfVoiceEvidence, citationRateEvidence } = rates || {};
      const model = labelOf(surface);
      return el('tr', {},
        el('td', {}, model),
        el('td', {}, ...rateFigure(shareOfVoice, shareOfVoiceEvidence, model + ' share of voice', 'Mentioned')),
        el('td', {}, ...rateFigure(citationRate, citationRateEvidence, model + ' citation rate', 'Cited')),
      );
    });
  if (!rows.length) return [];
  return [el('h3', {}, 'By model'), el('table', { class: 'by-model' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Model'), el('th', {}, 'Share of voice'),
      el('th', {}, 'Citation rate'))),
    el('tbody', {}, ...rows))];
};
const answerKey = (section, promptId, surface, runIndex) =>
  section + '|' + promptId + '|' + surface + '|' + runIndex;

const sourceLink = (url) => {
  // External sources open only on a deliberate click, in a new context.
  const button = el('button', { class: 'link', type: 'button' }, url);
  button.addEventListener('click', () => {
    if (/^https?:\\/\\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  });
  return button;
};

const render = async () => {
  const root = document.getElementById('app');
  const [info, verification, snapshot, captures, config] = await Promise.all([
    get('__viewer'), get('__verification'), get('report/snapshot.json'),
    get('captures/units.json'), get('inputs/config.json'),
  ]);
  root.replaceChildren();
  if (!info) {
    root.append(el('p', {}, 'This viewer link is not valid. Start it again with literally-aeo view.'));
    return;
  }
  const brand = (snapshot && snapshot.brand && snapshot.brand.name)
    || (config && config.brand && config.brand.name) || 'Audit';
  root.append(
    el('h1', {}, brand + ': AI visibility audit'),
    el('p', { class: 'muted' }, info.originLabel + ' · ' + info.source),
  );
  if (info.workingState) {
    root.append(el('div', { class: 'banner warn' },
      'Working state, not a finalized revision: this is not an integrity receipt. Export the run to finalize it.'));
  }
  if (verification) {
    const rows = verification.checks.map((check) => el('tr', {},
      el('td', {}, check.title),
      el('td', { class: check.outcome === 'pass' ? 'pass' : check.outcome === 'fail' ? 'fail' : 'limited' },
        check.outcome.replace('_', ' ')),
      el('td', { class: 'muted' }, check.outcome === 'pass' ? '' : check.explanation),
    ));
    root.append(el('h2', {}, 'Verification'),
      el('p', { class: 'muted' }, 'Capture authenticity: self-reported. Checks run on this machine, offline.'),
      el('div', { class: 'table-wrap' }, el('table', {}, el('tbody', {}, ...rows))));
  }
  if (!snapshot) {
    root.append(el('div', { class: 'banner' }, 'This run has no report yet: the measurement did not finish.'));
    return;
  }
  const answers = new Map();
  for (const record of captures || []) {
    answers.set(answerKey(record.sectionKey, record.promptId, record.surface, record.runIndex), record);
  }
  // The snapshot names prompts by text; their ids, which key the captured
  // answers, come from the frozen configuration in the same order.
  const promptIds = new Map();
  for (const configured of (config && config.sections) || []) {
    promptIds.set(configured.key, configured.prompts.map((prompt) => prompt.id));
  }

  // A surface asked of another model than its default, and every custom
  // surface, carries its own label in the snapshot; any other is shown by
  // its ID. Like every string of a bundle, a label is inserted as text.
  const labels = (snapshot.meta && snapshot.meta.surfaceLabels) || {};
  const labelOf = (surface) =>
    typeof labels[surface] === 'string' && labels[surface] ? labels[surface] : surface;

  for (const section of snapshot.sections) {
    const { summary, matrix, prompts } = section.visibility;
    root.append(el('h2', {}, 'Section ' + section.key));
    root.append(el('div', { class: 'grid' },
      rateStat('Assistant share of voice', summary.prospectShareOfVoice,
        summary.prospectShareOfVoiceEvidence, 'Mentioned'),
      rateStat('Assistant citation rate', summary.prospectCitationRate,
        summary.prospectCitationRateEvidence, 'Cited'),
      rateStat('Coding-agent share of voice', summary.agentShareOfVoice,
        summary.agentShareOfVoiceEvidence, 'Mentioned'),
      rateStat('Coding-agent citation rate', summary.agentCitationRate,
        summary.agentCitationRateEvidence, 'Cited'),
      // The scraped consumer apps, only for a run that planned one.
      ...(summary.consumerShareOfVoice === undefined ? [] : [
        rateStat('Consumer-app share of voice', summary.consumerShareOfVoice,
          summary.consumerShareOfVoiceEvidence, 'Mentioned'),
        rateStat('Consumer-app citation rate', summary.consumerCitationRate,
          summary.consumerCitationRateEvidence, 'Cited'),
      ]),
      el('div', { class: 'stat' }, el('b', {}, summary.topCompetitorDomain || 'none'), 'Most mentioned competitor'),
    ));
    root.append(el('p', { class: 'muted' },
      'Share of voice is how often the measured answers name the product, not market share.'));
    root.append(...modelTable(summary.byModel, labelOf));
    const drawer = el('div', { class: 'drawer', hidden: '' });
    const body = el('tbody');
    for (const row of matrix) {
      const prompt = prompts[row.promptIdx] || { text: '' };
      const promptId = (promptIds.get(section.key) || [])[row.promptIdx];
      const record = answers.get(answerKey(section.key, promptId, row.surface, row.runIndex || 0));
      const open = () => {
        drawer.removeAttribute('hidden');
        drawer.replaceChildren(
          el('h3', {}, labelOf(row.surface) + ', run ' + (row.runIndex || 0)),
          el('p', {}, prompt.text),
          record ? el('pre', {}, record.probe.text)
                 : el('p', { class: 'limited' }, 'The answer is not in this bundle.'),
          ...(row.citedUrls && row.citedUrls.length
            ? [el('h3', {}, 'Cited sources'), ...row.citedUrls.map((url) => el('div', {}, sourceLink(url)))]
            : []),
        );
        drawer.scrollIntoView({ block: 'nearest' });
      };
      body.append(el('tr', { class: 'row', tabindex: '0', onclick: open,
        onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } } },
        el('td', {}, prompt.text),
        el('td', {}, labelOf(row.surface)),
        el('td', {}, String(row.runIndex || 0)),
        el('td', {}, row.prospectMentioned ? 'mentioned' + (row.prospectPosition ? ' (' + row.prospectPosition + ')' : '') : 'not mentioned'),
        el('td', {}, (row.qualifiedCompetitors || []).map((entry) => entry.name).join(', ')),
      ));
    }
    root.append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Question'), el('th', {}, 'Surface'),
        el('th', {}, 'Run'), el('th', {}, 'Product'), el('th', {}, 'Alternatives named'))),
      body)), drawer);
  }
  const methodology = snapshot.meta && Array.isArray(snapshot.meta.methodology)
    ? snapshot.meta.methodology.filter((sentence) => typeof sentence === 'string')
    : [];
  if (methodology.length) {
    root.append(el('h2', {}, 'Methodology'),
      el('ul', { class: 'methodology' },
        ...methodology.map((sentence) => el('li', {}, sentence))));
  }
  root.append(el('footer', {},
    'Generated with Literally.dev AEO, an open-source AI visibility audit tool. ',
    info.originLabel + '. Literally.dev did not review this result. Engine ' + info.toolVersion + '.'));
};

render().catch((error) => {
  document.getElementById('app').textContent = 'The viewer could not load this bundle: ' + error.message;
});
`;

/** viewerPage is the document served at /, bound to one launch's nonce. */
export const viewerPage = (nonce: string): string => {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Literally.dev AEO</title>
<style nonce="${nonce}">${styles}</style>
</head>
<body>
<main id="app"><p class="muted">Loading the audit…</p></main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
};
