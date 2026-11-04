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

  for (const section of snapshot.sections) {
    const { summary, matrix, prompts } = section.visibility;
    root.append(el('h2', {}, 'Section ' + section.key));
    root.append(el('div', { class: 'grid' },
      el('div', { class: 'stat' }, el('b', {}, percent(summary.prospectShareOfVoice)), 'Assistant share of voice'),
      el('div', { class: 'stat' }, el('b', {}, percent(summary.prospectCitationRate)), 'Assistant citation rate'),
      el('div', { class: 'stat' }, el('b', {}, percent(summary.agentShareOfVoice)), 'Coding-agent share of voice'),
      el('div', { class: 'stat' }, el('b', {}, summary.topCompetitorDomain || 'none'), 'Most mentioned competitor'),
    ));
    root.append(el('p', { class: 'muted' },
      'Share of voice is how often the measured answers name the product, not market share.'));
    const drawer = el('div', { class: 'drawer', hidden: '' });
    const body = el('tbody');
    for (const row of matrix) {
      const prompt = prompts[row.promptIdx] || { text: '' };
      const promptId = (promptIds.get(section.key) || [])[row.promptIdx];
      const record = answers.get(answerKey(section.key, promptId, row.surface, row.runIndex || 0));
      const open = () => {
        drawer.removeAttribute('hidden');
        drawer.replaceChildren(
          el('h3', {}, row.surface + ', run ' + (row.runIndex || 0)),
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
        el('td', {}, row.surface),
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
