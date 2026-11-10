import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CalculationVersion } from '../bundle/contracts';
import { exportRun } from '../bundle/export';
import { readBundleSource } from '../bundle/read';
import { createSyntheticRun } from '../bundle/__fixtures__/synthetic-run';
import { intervalPercents } from '../report/core/rate-interval';
import { viewerPage } from './page';
import { startViewer, type ViewerServer } from './server';

// The page's own script runs against the real viewer server, with a minimal
// document standing in for the browser's: enough to read what it renders
// and to send it the events a pointer, a keyboard or a tap would.

type FakeEvent = { key: string; preventDefault: () => void };
type Listener = (event: FakeEvent) => void;
type Listeners = Map<string, Listener[]>;

type FakeElement = {
  tag: string;
  className: string;
  attributes: Map<string, string>;
  listeners: Listeners;
  children: Array<FakeElement | string>;
  /** Set only by the page's failure handler. */
  textContent?: string;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  addEventListener: (type: string, listener: Listener) => void;
  scrollIntoView: () => void;
  focus: () => void;
  append: (...nodes: Array<FakeElement | string>) => void;
  replaceChildren: (...nodes: Array<FakeElement | string>) => void;
};

const listen = (listeners: Listeners, type: string, listener: Listener) => {
  listeners.set(type, [...(listeners.get(type) ?? []), listener]);
};

const dispatch = (target: { listeners: Listeners }, type: string, key = '') => {
  for (const listener of target.listeners.get(type) ?? []) {
    listener({ key, preventDefault: () => undefined });
  }
};

// As in a browser, focus fires only when focus moves, and the element that
// loses it receives blur.
let activeElement: FakeElement | undefined;

const moveFocusTo = (element: FakeElement | undefined) => {
  const previous = activeElement;

  if (previous === element) {
    return;
  }
  activeElement = element;
  if (previous !== undefined) {
    dispatch(previous, 'blur');
  }
  if (element !== undefined) {
    dispatch(element, 'focus');
  }
};

const fakeElement = (tag: string): FakeElement => {
  const element: FakeElement = {
    tag,
    className: '',
    attributes: new Map(),
    listeners: new Map(),
    children: [],
    setAttribute: (name, value) => {
      element.attributes.set(name, value);
    },
    removeAttribute: (name) => {
      element.attributes.delete(name);
    },
    addEventListener: (type, listener) => {
      listen(element.listeners, type, listener);
    },
    scrollIntoView: () => undefined,
    focus: () => {
      moveFocusTo(element);
    },
    append: (...nodes) => {
      element.children.push(...nodes);
    },
    replaceChildren: (...nodes) => {
      element.children.splice(0, element.children.length, ...nodes);
    },
  };

  return element;
};

const elementsOf = (node: FakeElement | string): FakeElement[] => {
  return typeof node === 'string'
    ? []
    : [node, ...node.children.flatMap(elementsOf)];
};

const childElementsOf = (element: FakeElement): FakeElement[] => {
  return element.children.filter((child) => typeof child !== 'string');
};

const textOf = (node: FakeElement | string): string => {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
};

/** The text a sighted reader sees: hidden elements contribute none. */
const visibleTextOf = (node: FakeElement | string): string => {
  if (typeof node === 'string') {
    return node;
  }

  return node.attributes.has('hidden')
    ? ''
    : node.children.map(visibleTextOf).join('');
};

const pageScript = (): string => {
  const script = /<script nonce="n">([\s\S]*)<\/script>/.exec(
    viewerPage('n'),
  )?.[1];

  if (script === undefined) {
    throw new Error('The viewer page has no script.');
  }

  return script;
};

type RenderedPage = {
  root: FakeElement;
  document: { listeners: Listeners };
};

const renderPage = async (viewer: ViewerServer): Promise<RenderedPage> => {
  const root = fakeElement('main');

  activeElement = undefined;
  const documentListeners: Listeners = new Map();
  const served = new URL(viewer.url);
  const context = vm.createContext({
    location: { search: served.search },
    URLSearchParams,
    fetch: (url: string) => fetch(new URL(url, served)),
    window: {},
    document: {
      getElementById: () => root,
      createElement: fakeElement,
      createTextNode: (text: string) => text,
      addEventListener: (type: string, listener: Listener) => {
        listen(documentListeners, type, listener);
      },
    },
  });
  const rendering: unknown = vm.runInContext(pageScript(), context);

  await rendering;
  if (root.textContent !== undefined) {
    throw new Error(root.textContent);
  }

  return { root, document: { listeners: documentListeners } };
};

/** What an element shows, and the counts a screen reader reads with it. */
const readableOf = (root: FakeElement, element: FakeElement) => {
  const describedBy = elementsOf(element)
    .map((inner) => inner.attributes.get('aria-describedby'))
    .find((id) => id !== undefined);
  const description = elementsOf(root).find(
    (candidate) =>
      describedBy !== undefined &&
      candidate.attributes.get('id') === describedBy,
  );

  return {
    text: visibleTextOf(element),
    counts: description && textOf(description),
  };
};

const statsOf = ({ root }: RenderedPage) => {
  return elementsOf(root)
    .filter((element) => element.className === 'stat')
    .map((stat) => readableOf(root, stat));
};

const modelRowsOf = ({ root }: RenderedPage) => {
  return elementsOf(root)
    .filter((element) => element.tag === 'tbody')
    .filter((tbody) =>
      elementsOf(root).some(
        (table) =>
          table.className === 'by-model' && table.children.includes(tbody),
      ),
    )
    .map((tbody) =>
      childElementsOf(tbody).map((row) =>
        childElementsOf(row).map((cell) => readableOf(root, cell)),
      ),
    );
};

const snapshotPath = 'report/snapshot.json';

const editableSnapshotSchema = z.looseObject({
  sections: z.array(
    z.looseObject({
      visibility: z.looseObject({ summary: z.looseObject({}) }),
    }),
  ),
});

let root: string;
const viewers: ViewerServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-viewer-page-'));
});

afterEach(async () => {
  await Promise.all(viewers.splice(0).map((viewer) => viewer.close()));
  await rm(root, { recursive: true, force: true });
});

const exportedFiles = async (calculationVersion: CalculationVersion) => {
  const run = await createSyntheticRun(
    path.join(root, `run-${calculationVersion}`),
    { calculationVersion },
  );
  const { archive } = await exportRun(run.dir);

  return readBundleSource(archive);
};

const viewerFor = async (source: {
  files: ReadonlyMap<string, Buffer>;
  description: string;
}) => {
  const viewer = await startViewer({ ...source, workingState: false });

  viewers.push(viewer);

  return viewer;
};

describe('viewer - viewerPage()', () => {
  it('should show the interval beside each headline rate, and its counts as its description', async () => {
    const page = await renderPage(await viewerFor(await exportedFiles(2)));

    expect(statsOf(page).slice(0, 5)).toEqual([
      {
        // Two of the eight planned answers are missing: the interval covers
        // both outcomes for them.
        text: '25%approx. 95% interval 7–79%Assistant share of voice',
        counts: 'Mentioned in 2 of 8 planned answers; 6 captured',
      },
      {
        text: '25%approx. 95% interval 7–79%Assistant citation rate',
        counts: 'Cited in 2 of 8 planned answers; 6 captured',
      },
      // No coding agent was planned: no rate, so no interval.
      { text: 'n/aCoding-agent share of voice', counts: undefined },
      { text: 'n/aCoding-agent citation rate', counts: undefined },
      { text: 'rivalstack.testMost mentioned competitor', counts: undefined },
    ]);
  });

  it("should show each model's rates, each with its interval and counts", async () => {
    const page = await renderPage(await viewerFor(await exportedFiles(2)));

    expect(modelRowsOf(page)).toEqual([
      [
        [
          { text: 'chatgpt', counts: undefined },
          {
            text: '25%approx. 95% interval 4–96%',
            counts: 'Mentioned in 1 of 4 planned answers; 2 captured',
          },
          {
            text: '25%approx. 95% interval 4–96%',
            counts: 'Cited in 1 of 4 planned answers; 2 captured',
          },
        ],
        [
          { text: 'perplexity', counts: undefined },
          {
            text: '25%approx. 95% interval 4–70%',
            counts: 'Mentioned in 1 of 4 planned answers; 4 captured',
          },
          {
            text: '25%approx. 95% interval 4–70%',
            counts: 'Cited in 1 of 4 planned answers; 4 captured',
          },
        ],
      ],
      [
        [
          { text: 'chatgpt', counts: undefined },
          {
            text: '0%approx. 95% interval 0–66%',
            counts: 'Mentioned in 0 of 2 planned answers; 2 captured',
          },
          {
            text: '0%approx. 95% interval 0–66%',
            counts: 'Cited in 0 of 2 planned answers; 2 captured',
          },
        ],
        [
          { text: 'perplexity', counts: undefined },
          {
            text: '50%approx. 95% interval 9–91%',
            counts: 'Mentioned in 1 of 2 planned answers; 2 captured',
          },
          {
            text: '50%approx. 95% interval 9–91%',
            counts: 'Cited in 1 of 2 planned answers; 2 captured',
          },
        ],
      ],
    ]);
  });

  it('should show a version 1 bundle bare rates, as before', async () => {
    const page = await renderPage(await viewerFor(await exportedFiles(1)));

    expect(statsOf(page).slice(0, 4)).toEqual([
      { text: '25%Assistant share of voice', counts: undefined },
      { text: '25%Assistant citation rate', counts: undefined },
      { text: 'n/aCoding-agent share of voice', counts: undefined },
      { text: 'n/aCoding-agent citation rate', counts: undefined },
    ]);
    expect(modelRowsOf(page)[0]).toEqual([
      [
        { text: 'chatgpt', counts: undefined },
        { text: '25%', counts: undefined },
        { text: '25%', counts: undefined },
      ],
      [
        { text: 'perplexity', counts: undefined },
        { text: '25%', counts: undefined },
        { text: '25%', counts: undefined },
      ],
    ]);
  });

  it("should round an interval as the report's own rule does", async () => {
    // The page is one self-contained script and carries its own copy of the
    // rounding rule: held here to the answers of the shared one.
    const bounds = [
      { low: 0.07, high: 0.93 },
      { low: 0.071494, high: 0.591181 },
      { low: 0, high: 1 },
      { low: 0.29, high: 0.57 },
    ];
    const source = await exportedFiles(2);
    const snapshot = editableSnapshotSchema.parse(
      JSON.parse(String(source.files.get(snapshotPath))),
    );
    const summary = snapshot.sections[0]?.visibility.summary;

    if (summary === undefined) {
      throw new Error('The synthetic snapshot has no section.');
    }

    for (const bound of bounds) {
      summary['prospectShareOfVoiceEvidence'] = {
        count: 2,
        captured: 20,
        planned: 20,
        ...bound,
      };
      const files = new Map(source.files).set(
        snapshotPath,
        Buffer.from(JSON.stringify(snapshot)),
      );
      const page = await renderPage(await viewerFor({ ...source, files }));
      const { low, high } = intervalPercents(bound);

      expect(statsOf(page)[0]?.text).toContain(
        `approx. 95% interval ${low}–${high}%`,
      );
    }
  });

  it('should round an interval outward to whole percents, and drop malformed evidence', async () => {
    const source = await exportedFiles(2);
    const snapshot = editableSnapshotSchema.parse(
      JSON.parse(String(source.files.get(snapshotPath))),
    );
    const summary = snapshot.sections[0]?.visibility.summary;

    if (summary === undefined) {
      throw new Error('The synthetic snapshot has no section.');
    }
    // 0.07 * 100 is 7.000000000000001: a naive ceiling would show 8%.
    summary['prospectShareOfVoiceEvidence'] = {
      count: 2,
      captured: 20,
      planned: 20,
      low: 0.07,
      high: 0.93,
    };
    summary['prospectCitationRateEvidence'] = {
      count: 2,
      captured: 20,
      planned: 20,
      low: 0.9,
      high: 0.1,
    };
    const files = new Map(source.files).set(
      snapshotPath,
      Buffer.from(JSON.stringify(snapshot)),
    );
    const page = await renderPage(await viewerFor({ ...source, files }));

    expect(statsOf(page).slice(0, 2)).toEqual([
      {
        text: '25%approx. 95% interval 7–93%Assistant share of voice',
        counts: 'Mentioned in 2 of 20 planned answers; 20 captured',
      },
      { text: '25%Assistant citation rate', counts: undefined },
    ]);
  });

  it("should show a surface by the snapshot's own label when it has one, as text", async () => {
    const source = await exportedFiles(2);
    const snapshot = z
      .looseObject({ meta: z.looseObject({}) })
      .parse(JSON.parse(String(source.files.get(snapshotPath))));

    // A model override names the model; a label is never markup.
    snapshot.meta['surfaceLabels'] = {
      chatgpt: 'ChatGPT (API, openai/gpt-test-1)',
      perplexity: '<b>Sonar</b>',
    };
    const files = new Map(source.files).set(
      snapshotPath,
      Buffer.from(JSON.stringify(snapshot)),
    );
    const page = await renderPage(await viewerFor({ ...source, files }));

    expect(modelRowsOf(page)[0]?.map((cells) => cells[0]?.text)).toEqual([
      'ChatGPT (API, openai/gpt-test-1)',
      '<b>Sonar</b>',
    ]);
    expect(
      elementsOf(page.root).some(
        (element) => element.tag === 'b' && visibleTextOf(element) === 'Sonar',
      ),
    ).toBe(false);
  });

  it('should show the methodology the snapshot carries, as a list of plain sentences', async () => {
    const source = await exportedFiles(2);
    const snapshot = z
      .looseObject({ meta: z.looseObject({}) })
      .parse(JSON.parse(String(source.files.get(snapshotPath))));

    snapshot.meta['methodology'] = [
      'A rate is a share of the planned answers.',
      '<i>Never markup.</i>',
    ];
    const files = new Map(source.files).set(
      snapshotPath,
      Buffer.from(JSON.stringify(snapshot)),
    );
    const page = await renderPage(await viewerFor({ ...source, files }));
    const items = elementsOf(page.root)
      .filter((element) => element.tag === 'li')
      .map(visibleTextOf);

    expect(items).toEqual([
      'A rate is a share of the planned answers.',
      '<i>Never markup.</i>',
    ]);
    expect(elementsOf(page.root).some((element) => element.tag === 'i')).toBe(
      false,
    );
  });

  it('should open the counts on hover, focus and tap, keep them open while either lasts, and close them with Escape', async () => {
    const page = await renderPage(await viewerFor(await exportedFiles(2)));
    const interval = elementsOf(page.root).find(
      (element) => element.className === 'interval',
    );
    const trigger = interval && childElementsOf(interval)[0];
    const tip = elementsOf(page.root).find(
      (element) =>
        element.attributes.get('id') ===
        trigger?.attributes.get('aria-describedby'),
    );

    if (interval === undefined || trigger === undefined || tip === undefined) {
      throw new Error('The page shows no interval with counts.');
    }
    const isOpen = () => !tip.attributes.has('hidden');

    expect(trigger.tag).toBe('button');
    expect(trigger.attributes.get('type')).toBe('button');
    expect(trigger.attributes.get('aria-label')).toBe(
      'approx. 95% interval 7–79% for assistant share of voice',
    );
    expect(tip.attributes.get('role')).toBe('tooltip');
    expect(isOpen()).toBe(false);

    trigger.focus();
    expect(isOpen()).toBe(true);
    dispatch(page.document, 'keydown', 'a');
    expect(isOpen()).toBe(true);
    dispatch(page.document, 'keydown', 'Escape');
    expect(isOpen()).toBe(false);
    // Enter or Space on the button, which kept focus, clicks it.
    dispatch(trigger, 'click');
    expect(isOpen()).toBe(true);
    moveFocusTo(undefined);
    expect(isOpen()).toBe(false);

    dispatch(interval, 'mouseenter');
    expect(isOpen()).toBe(true);
    trigger.focus();
    dispatch(interval, 'mouseleave');
    expect(isOpen()).toBe(true);
    moveFocusTo(undefined);
    expect(isOpen()).toBe(false);

    // A tap, or a click in Safari, which focuses no button by itself.
    dispatch(trigger, 'click');
    expect(isOpen()).toBe(true);
  });
});
