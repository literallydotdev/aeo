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

const editableSnapshotSchema = z.looseObject({ meta: z.looseObject({}) });

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

/** The exported bundle with its snapshot's meta edited. */
const withMeta = async (meta: Record<string, unknown>) => {
  const source = await exportedFiles(2);
  const snapshot = editableSnapshotSchema.parse(
    JSON.parse(String(source.files.get(snapshotPath))),
  );

  Object.assign(snapshot.meta, meta);

  return {
    ...source,
    files: new Map(source.files).set(
      snapshotPath,
      Buffer.from(JSON.stringify(snapshot)),
    ),
  };
};

const byClass = (root: FakeElement, className: string) => {
  return elementsOf(root).filter((element) =>
    element.className.split(' ').includes(className),
  );
};

describe('viewer - viewerPage()', () => {
  it('should show each scorecard with its interval, and the counts as its description', async () => {
    const page = await renderPage(await viewerFor(await exportedFiles(2)));

    expect(statsOf(page).slice(0, 3)).toEqual([
      {
        text: '25%approx. 95% interval 7–79%Share of voice — AI assistants25% citation rate across ChatGPT and Perplexityapprox. 95% interval 7–79%',
        counts: 'Mentioned in 2 of 8 planned answers; 6 captured',
      },
      {
        text: '100%Rivalstack share of voiceNamed most often: 6 of 6 captured answers',
        counts: undefined,
      },
      {
        text: '1/3Cells with zero mentionsPrompts and surfaces where the brand was absent',
        counts: undefined,
      },
    ]);
  });

  it("should show each surface's rates, each with its interval and counts", async () => {
    const page = await renderPage(await viewerFor(await exportedFiles(2)));

    expect(modelRowsOf(page)[0]).toEqual([
      [
        { text: 'ChatGPT', counts: undefined },
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
        { text: 'Perplexity', counts: undefined },
        {
          text: '25%approx. 95% interval 4–70%',
          counts: 'Mentioned in 1 of 4 planned answers; 4 captured',
        },
        {
          text: '25%approx. 95% interval 4–70%',
          counts: 'Cited in 1 of 4 planned answers; 4 captured',
        },
      ],
    ]);
  });

  it('should insert labels and methodology from the bundle as text, never as markup', async () => {
    const page = await renderPage(
      await viewerFor(
        await withMeta({
          surfaceLabels: { perplexity: '<b>Sonar</b>' },
          methodology: [
            'A rate is a share of the planned answers.',
            '<i>Never markup.</i>',
          ],
        }),
      ),
    );
    const methodology = elementsOf(page.root).find(
      (element) => element.className === 'methodology',
    );

    expect(modelRowsOf(page)[0]?.map((cells) => cells[0]?.text)).toEqual([
      'ChatGPT',
      '<b>Sonar</b>',
    ]);
    expect(
      methodology && childElementsOf(methodology).map(visibleTextOf),
    ).toEqual([
      'A rate is a share of the planned answers.',
      '<i>Never markup.</i>',
    ]);
    expect(
      elementsOf(page.root).some(
        (element) => element.tag === 'b' || element.tag === 'i',
      ),
    ).toBe(false);
  });

  it('should open the evidence behind a matrix cell in a sheet, and close it with Escape', async () => {
    const page = await renderPage(await viewerFor(await exportedFiles(2)));
    const [sheet] = byClass(page.root, 'sheet');
    const [cell] = byClass(page.root, 'cell');

    if (sheet === undefined || cell === undefined) {
      throw new Error('The page shows no matrix cell or no sheet.');
    }
    expect(sheet.attributes.has('hidden')).toBe(true);

    cell.focus();
    dispatch(cell, 'click');

    expect(sheet.attributes.has('hidden')).toBe(false);
    expect(visibleTextOf(sheet)).toContain('Perplexity evidence');
    expect(visibleTextOf(sheet)).toContain('Full captured answer');
    expect(byClass(sheet, 'run')).toHaveLength(2);

    dispatch(page.document, 'keydown', 'Escape');

    expect(sheet.attributes.has('hidden')).toBe(true);
    // Focus returns to the cell that opened the sheet.
    expect(activeElement).toBe(cell);
  });

  it('should say so when the run has no report yet', async () => {
    const source = await exportedFiles(2);
    const files = new Map(source.files);

    files.delete(snapshotPath);
    const page = await renderPage(await viewerFor({ ...source, files }));

    expect(visibleTextOf(page.root)).toContain(
      'This run has no report yet: the measurement did not finish.',
    );
    expect(statsOf(page)).toEqual([]);
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
      'approx. 95% interval 7–79% for share of voice across AI assistants',
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
