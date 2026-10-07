import { describe, expect, it } from 'vitest';

import { exitMarkNames } from './art';
import type { PublicLevel, RunRequest, RunResponse } from './contract';
import { GLOBAL_TABOO, UI_TEXT } from './messages';
import { badgeCorner, mount, mountApp } from './mount';
import type { AppServices } from './mount';
import { STARS_ITEM } from './progress';
import type { ProgressStore } from './progress';
import { dressScene } from './scene';
import { FRAME_MS } from './style';

// --- A document, by hand -----------------------------------------------------
//
// Vitest runs under `environment: 'node'`, so there is no DOM here and no jsdom
// to reach for. The page is written against a small slice of the document —
// create an element, set a property or an attribute, append, replace, listen —
// and that slice is small enough to stand in for honestly. What it cannot stand
// in for is layout and drawing, and this file asserts nothing about either: the
// scenery is drawn onto canvases whose pens draw nothing, and the tests read
// only where it went and what it says about itself.

type FakeEvent = { key?: string; preventDefault: () => void };

class FakeElement {
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  readonly attributes = new Map<string, string>();

  className = '';
  textContent = '';
  id = '';
  type = '';
  value = '';
  placeholder = '';
  htmlFor = '';
  autocomplete = '';
  spellcheck = false;
  rows = 0;
  disabled = false;
  /** As in a browser: a control is a tab stop, anything else is not until it is made one. */
  tabIndex = -1;
  parent: FakeElement | undefined;
  /** Inline style properties, as `style.setProperty` sets them. */
  readonly style = {
    props: new Map<string, string>(),
    setProperty(name: string, value: string): void {
      this.props.set(name, value);
    },
  };
  /** A canvas's size; a canvas here draws nothing. */
  width = 0;
  height = 0;

  /** Being revealed, hidden and filled, in the order it happened: what tells an alert that announces from one that does not. */
  readonly trace: string[] = [];
  #hidden = false;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {
    if (['button', 'input', 'select', 'summary', 'textarea'].includes(tagName)) this.tabIndex = 0;
  }

  get hidden(): boolean {
    return this.#hidden;
  }

  set hidden(value: boolean) {
    this.#hidden = value;
    this.trace.push(value ? 'hidden' : 'revealed');
  }

  append(...nodes: FakeElement[]): void {
    this.adopt(nodes);
    this.children.push(...nodes);
  }

  prepend(...nodes: FakeElement[]): void {
    this.adopt(nodes);
    this.children.unshift(...nodes);
  }

  before(...nodes: FakeElement[]): void {
    this.besides(nodes, 0);
  }

  after(...nodes: FakeElement[]): void {
    this.besides(nodes, 1);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.adopt(nodes);
    this.children.length = 0;
    this.children.push(...nodes);
    this.trace.push(`filled:${String(nodes.length)}`);
  }

  private adopt(nodes: readonly FakeElement[]): void {
    for (const node of nodes) node.parent = this;
  }

  private besides(nodes: FakeElement[], offset: number): void {
    const parent = this.parent;
    if (parent === undefined) throw new TypeError('no parent to put a sibling in');
    parent.adopt(nodes);
    parent.children.splice(parent.children.indexOf(this) + offset, 0, ...nodes);
  }

  /** `.class` selectors only: all the page and the scene ask for. */
  querySelectorAll(selector: string): FakeElement[] {
    const wanted = selector.replace(/^\./, '');
    return descendants(this).slice(1).filter((node) => node.className.split(' ').includes(wanted));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** A canvas's 2d context: every call accepted, nothing drawn. */
  getContext(): unknown {
    return this.ownerDocument.drawing ? { fillRect: () => undefined, drawImage: () => undefined, translate: () => undefined, clearRect: () => undefined } : null;
  }

  toDataURL(): string {
    return `data:image/png;base64,${String(this.width)}x${String(this.height)}`;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  focus(): void {
    this.ownerDocument.focused = this;
  }

  /** Every time the page asked to bring this into view, with how. */
  readonly scrolled: unknown[] = [];

  scrollIntoView(options?: unknown): void {
    this.scrolled.push(options);
  }

  fire(type: string, event: FakeEvent = { preventDefault: () => undefined }): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  click(): void {
    this.fire('click');
  }

  /** A key pressed while this element has the focus. */
  press(key: string): void {
    this.fire('keydown', { key, preventDefault: () => undefined });
  }
}

class FakeDocument {
  focused: FakeElement | undefined;
  /** Whether a canvas gives a context: a browser that will not draw gives none. */
  drawing = true;
  readonly documentElement: FakeElement = new FakeElement('html', this);
  /** Every interval the page started, by its period. */
  readonly intervals: number[] = [];
  still = false;
  readonly defaultView = {
    matchMedia: (query: string) => ({ matches: query.includes('reduce') && this.still }),
    setInterval: (_work: () => void, ms: number): number => this.intervals.push(ms),
  };

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

function descendants(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap(descendants)];
}

/** Every piece of text the page shows, as one string. */
function shownText(element: FakeElement): string {
  return descendants(element)
    .filter((node) => node.tagName !== 'style')
    .map((node) => node.textContent)
    .join('\n');
}

function byId(root: FakeElement, id: string): FakeElement {
  const found = descendants(root).find((node) => node.id === id);
  if (found === undefined) throw new Error(`no element with id ${id}`);
  return found;
}

function byClass(root: FakeElement, className: string): FakeElement {
  const found = descendants(root).find((node) => node.className.split(' ').includes(className));
  if (found === undefined) throw new Error(`no element with class ${className}`);
  return found;
}

/** The exit marks a switch square shows, by the side each stands on. */
function marksOf(cell: FakeElement): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const node of cell.children.filter((child) => child.className === 'rr-mark')) {
    const name = /--rr-art-mark-([\w-]+),/.exec(node.attributes.get('style') ?? '')?.[1] ?? '';
    marks[node.attributes.get('data-side') ?? '?'] = name;
  }
  return marks;
}

/** Every write to `element.textContent`, in order: a live region announces each one. */
function watchText(element: FakeElement): string[] {
  const writes: string[] = [];
  let current = element.textContent;
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get: () => current,
    set: (value: string) => {
      current = value;
      writes.push(value);
    },
  });
  return writes;
}

/** Everything written to the console while `run` was going on, by any method. */
async function withTrappedConsole(run: () => Promise<void>): Promise<unknown[]> {
  const original = globalThis.console;
  const logged: unknown[] = [];
  globalThis.console = new Proxy({} as Console, {
    get:
      () =>
      (...args: unknown[]): undefined => {
        logged.push(...args);
        return undefined;
      },
  });
  try {
    await run();
  } finally {
    globalThis.console = original;
  }
  return logged;
}

/** Lets every pending promise settle: the handlers start their work and return. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((done) => setTimeout(done, 0));
  }
}

// --- The levels and the backend, stood in for -----------------------------------

const FIRST: PublicLevel = {
  id: 'first-switch',
  name: 'First Switch',
  order: 1,
  width: 5,
  height: 3,
  cells: [
    { x: 0, y: 1, kind: 'start', rotation: 0, mode: 'fixed' },
    { x: 1, y: 1, kind: 'straight', rotation: 0, mode: 'rotatable' },
    { x: 4, y: 1, kind: 'mine', rotation: 0, mode: 'fixed' },
    { x: 3, y: 2, kind: 'tunnel', rotation: 1, mode: 'fixed' },
    { x: 0, y: 0, kind: 'rock', rotation: 0, mode: 'fixed' },
  ],
  switches: [
    {
      id: 'cargo',
      x: 3,
      y: 1,
      entry: 'W',
      question: {
        type: 'choice',
        instructions: 'What does the cart carry?',
        criteria: { coal: 'Coal or soot.', gold: 'Gold or any precious metal.' },
      },
      exits: { gold: 'E', coal: 'S' },
      threshold: null,
    },
  ],
  inventory: { straight: 1, curve: 0, cross: 0 },
  taboo: ['gold', 'ouro'],
  max_words: 5,
  par_pieces: 1,
};

const SECOND: PublicLevel = {
  ...FIRST,
  id: 'the-gate',
  name: 'The Gate',
  order: 2,
  switches: [
    {
      id: 'danger',
      x: 3,
      y: 1,
      entry: 'W',
      question: {
        type: 'noul',
        instructions: 'Is the cargo dangerous?',
        criteria: { true: 'It could explode.', false: 'It is safe.' },
      },
      exits: { yes: 'S', no: 'E' },
      threshold: 0.5,
    },
  ],
};

const ARRIVED: RunResponse = {
  outcome: 'arrived',
  path: [
    { x: 0, y: 1, from_side: null, to_side: 'E' },
    { x: 1, y: 1, from_side: 'W', to_side: 'E' },
    { x: 2, y: 1, from_side: 'W', to_side: 'E' },
    { x: 3, y: 1, from_side: 'W', to_side: 'E' },
    { x: 4, y: 1, from_side: 'W', to_side: null },
  ],
  readings: [
    {
      switch_id: 'cargo',
      type: 'choice',
      result: 'gold',
      confidence: 0.93,
      noul: null,
      threshold: null,
      score: null,
      margin: 0.93,
      clean: true,
    },
  ],
  stars: 2,
  cached: false,
  quota: { remaining: 7, byok: false },
};

type Answer = { status: number; body: unknown } | 'network' | 'hang';

type Sent = { url: string; method: string; headers: Record<string, string>; body: string };

type HarnessOptions = {
  levels?: unknown;
  levelsStatus?: number;
  levelsAnswer?: 'network';
  /** What each `POST /api/run` answers, in order; the last one repeats. */
  runs?: Answer[];
  storage?: ProgressStore;
  still?: boolean;
};

function memoryStore(initial?: string): ProgressStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set(STARS_ITEM, initial);
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function mountHarness(options: HarnessOptions = {}) {
  const doc = new FakeDocument();
  const root = new FakeElement('div', doc);
  const store = memoryStore();
  const sent: Sent[] = [];
  const asked: string[] = [];
  const waits: number[] = [];
  const runs = [...(options.runs ?? [{ status: 200, body: ARRIVED }])];

  const services: Partial<AppServices> = {
    fetch: (input, init) => {
      asked.push(input);
      if (input === '/api/levels') {
        if (options.levelsAnswer === 'network') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(
          new Response(JSON.stringify(options.levels ?? [SECOND, FIRST]), { status: options.levelsStatus ?? 200 }),
        );
      }
      sent.push({
        url: input,
        method: init?.method ?? 'GET',
        headers: { ...(init?.headers as Record<string, string>) },
        body: String(init?.body),
      });
      const answer = (runs.length > 1 ? runs.shift() : runs[0]) ?? 'hang';
      if (answer === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      if (answer === 'hang') return new Promise<Response>(() => undefined);
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    },
    storage: options.storage ?? store,
    reducedMotion: () => options.still ?? false,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  mountApp(root as unknown as HTMLElement, services);

  const cell = (x: number, y: number): FakeElement => {
    const found = descendants(root).find(
      (node) => node.attributes.get('data-x') === String(x) && node.attributes.get('data-y') === String(y),
    );
    if (found === undefined) throw new Error(`no cell at ${String(x)}, ${String(y)}`);
    return found;
  };
  const tool = (prefix: string): FakeElement => {
    const found = descendants(root).find(
      (node) => node.tagName === 'button' && node.className.includes('rr-tool') && node.textContent.startsWith(prefix),
    );
    if (found === undefined) throw new Error(`no tool ${prefix}`);
    return found;
  };

  return {
    root,
    doc,
    store,
    sent,
    asked,
    waits,
    picker: byId(root, 'rr-level'),
    sentence: byId(root, 'rr-sentence'),
    key: byId(root, 'rr-key'),
    keyField: descendants(root).find((node) => node.className === 'rr-field' && node.children.some((c) => c.id === 'rr-key'))!,
    send: byClass(root, 'rr-go'),
    status: byClass(root, 'rr-status'),
    failure: byClass(root, 'rr-failure'),
    readings: byClass(root, 'rr-readings'),
    quota: byClass(root, 'rr-quota'),
    cart: byClass(root, 'rr-cart'),
    cell,
    tool,
    /** The art name a cell is showing, read from its piece's style. */
    art: (x: number, y: number): string => cell(x, y).children[0]?.attributes.get('style') ?? '',
    text: () => shownText(root),
    type: (value: string) => {
      const field = byId(root, 'rr-sentence');
      field.value = value;
      field.fire('input');
    },
    request: (index = 0): RunRequest => JSON.parse(sent[index]?.body ?? '{}') as RunRequest,
  };
}

/** A harness with the levels loaded and a note written, ready to send. */
async function ready(options: HarnessOptions = {}) {
  const app = mountHarness(options);
  await settle();
  app.type('A heavy load of nuggets');
  return app;
}

// --- The page -------------------------------------------------------------------

describe('the page the run is planned on', () => {
  it('labels every field, bound to the control it names', () => {
    const app = mountHarness();
    const labels = descendants(app.root).filter((node) => node.tagName === 'label');
    expect(labels.map((label) => label.htmlFor).sort()).toEqual(['rr-key', 'rr-level', 'rr-sentence']);
    for (const label of labels) expect(label.textContent).not.toBe('');
    expect(app.sentence.tagName).toBe('textarea');
    expect(app.picker.tagName).toBe('select');
  });

  it('has one main button, and it sends the cart', () => {
    const app = mountHarness();
    const main = descendants(app.root).filter((node) => node.className.includes('rr-go'));
    expect(main).toHaveLength(1);
    expect(main[0]?.textContent).toBe('Send the cart');
  });

  it('puts the status and the failure in live regions', () => {
    const app = mountHarness();
    expect(app.status.attributes.get('role')).toBe('status');
    expect(app.status.attributes.get('aria-live')).toBe('polite');
    expect(app.failure.attributes.get('role')).toBe('alert');
    expect(app.failure.attributes.get('aria-live')).toBe('assertive');
    expect(app.failure.hidden).toBe(true);
  });

  it('makes the scrolling part of the plan a named tab stop, so the keyboard can reach and scroll it', () => {
    const app = mountHarness();
    const body = byClass(app.root, 'rr-board-body');
    expect(body.tabIndex).toBe(0);
    expect(body.attributes.get('role')).toBe('region');
    expect(body.attributes.get('aria-label')).toBe(UI_TEXT.planBodyLabel);
    expect(descendants(body)).toContain(byId(app.root, 'rr-sentence-taboo'));
    expect(descendants(body)).toContain(byClass(app.root, 'rr-switches'));
  });

  it('mounts with nothing but a root, the way main.ts calls it, and says the levels did not load', async () => {
    // Every service is the real one here, and in Node `fetch('/api/levels')`
    // has no page to be relative to, so it fails the way a dead network does.
    const doc = new FakeDocument();
    const root = new FakeElement('div', doc);
    const logged = await withTrappedConsole(async () => {
      expect(() => {
        mount(root as unknown as HTMLElement);
      }).not.toThrow();
      await settle();
    });
    expect(logged).toEqual([]);
    expect(shownText(root)).toContain(UI_TEXT.levelsFailed);
  });
});

describe('loading the levels', () => {
  it('asks the backend for them and lists them in play order', async () => {
    const app = mountHarness();
    expect(app.status.textContent).toBe(UI_TEXT.loadingLevels);
    await settle();

    expect(app.asked[0]).toBe('/api/levels');
    expect(app.picker.children.map((option) => option.value)).toEqual(['first-switch', 'the-gate']);
    expect(app.picker.children.map((option) => option.textContent)).toEqual(['1. First Switch', '2. The Gate']);
    expect(app.picker.disabled).toBe(false);
  });

  it('lays out the first level: a square per cell, its switches with their questions and exits', async () => {
    const app = mountHarness();
    await settle();

    const cells = descendants(app.root).filter((node) => node.className === 'rr-cell');
    expect(cells).toHaveLength(15);
    expect(app.text()).toContain('First Switch');
    expect(app.text()).toContain('What does the cart carry?');
    expect(app.text()).toContain('Gold or any precious metal.');
    expect(app.text()).toContain('east →');
    expect(app.text()).toContain('Forbidden words: gold, ouro.');
    expect(app.text()).toContain('Up to 5 words');
    expect(app.cell(3, 1).attributes.get('aria-label')).toContain('Switch A');
    expect(app.art(3, 1)).toBe('--art: var(--rr-art-junction-W-ES, none)');
    expect(app.art(4, 1)).toContain('--rr-art-mine-0');
  });

  it('lists the level’s own forbidden words, and folds the global ones away, closed', async () => {
    const app = mountHarness({ levels: [{ ...FIRST, taboo: ['gold', 'ouro', ...GLOBAL_TABOO] }] });
    await settle();
    expect(byId(app.root, 'rr-sentence-taboo').textContent).toBe('Forbidden words: gold, ouro.');
    const folded = descendants(app.root).filter((node) => node.tagName === 'details');
    expect(folded).toHaveLength(1);
    const [block] = folded;
    expect(block?.hidden).toBe(false);
    expect(block?.attributes.has('open')).toBe(false);
    expect((block as unknown as { open?: boolean }).open).not.toBe(true);
    expect(block?.children[0]?.tagName).toBe('summary');
    expect(block?.children[0]?.textContent).toBe(UI_TEXT.globalTabooSummary);
    expect(shownText(block!)).toContain(`${GLOBAL_TABOO.join(', ')}.`);
    // Folded away, and still warned about as the note is typed.
    app.type('the first nuggets');
    expect(app.text()).toContain('It uses a forbidden word: first.');
  });

  it('has no folded block on a level whose list has no global terms', async () => {
    const app = mountHarness();
    await settle();
    expect(descendants(app.root).find((node) => node.tagName === 'details')?.hidden).toBe(true);
  });

  it('opens on the first level not yet finished', async () => {
    const app = mountHarness({ storage: memoryStore('{"first-switch": 3}') });
    await settle();
    expect(app.picker.value).toBe('the-gate');
    expect(app.picker.children[0]?.textContent).toBe('1. First Switch ★★★');
  });

  it('switches level from the picker, and the board and the switches follow', async () => {
    const app = mountHarness();
    await settle();
    app.picker.value = 'the-gate';
    app.picker.fire('change');

    expect(app.text()).toContain('Is the cargo dangerous?');
    expect(app.text()).not.toContain('What does the cart carry?');
    expect(app.text()).toContain('yes (Jev at least 50% sure)');
    expect(byClass(app.cell(3, 1), 'rr-badge').className).toBe('rr-badge rr-type-noul');
    expect(marksOf(app.cell(3, 1))).toEqual({ E: 'no', S: 'yes' });
  });

  for (const [what, options] of [
    ['the network is down', { levelsAnswer: 'network' }],
    ['the server fails', { levelsStatus: 500 }],
    ['the answer is not a list', { levels: { error: 'nope' } }],
    ['the list is empty', { levels: [] }],
  ] as const) {
    it(`says what to do when ${what}, and offers nothing to send`, async () => {
      const app = mountHarness(options);
      await settle();
      expect(app.failure.hidden).toBe(false);
      expect(app.text()).toContain(UI_TEXT.levelsFailed);
      expect(app.send.disabled).toBe(true);
    });
  }
});

describe('a switch, on the board and in the list', () => {
  it('shows its track and one badge, with its letter and a glyph for its kind, hidden from a screen reader', async () => {
    const app = mountHarness();
    await settle();
    const square = app.cell(3, 1);
    const badges = descendants(square).filter((node) => node.className.split(' ').includes('rr-badge'));
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe('A');
    expect(badges[0]?.className).toBe('rr-badge rr-type-choice');
    expect(badges[0]?.attributes.get('aria-hidden')).toBe('true');
    // The square's own label still says it all in words.
    expect(square.attributes.get('aria-label')).toBe('Switch A, points: What does the cart carry?, row 2, column 4');
  });

  it('sets the badge in the corner across from the entry, where no branch runs, its letter drawn', async () => {
    const app = mountHarness();
    await settle();
    const badge = byClass(app.cell(3, 1), 'rr-badge');
    expect(badge.attributes.get('data-corner')).toBe('ne');
    expect(badge.attributes.get('style')).toBe('--letter: var(--rr-art-letter-A, none)');
  });

  it('puts at the end of each branch the mark of the answer that leads there, hidden from a screen reader', async () => {
    const app = mountHarness();
    await settle();
    expect(marksOf(app.cell(3, 1))).toEqual({ E: 'gold', S: 'coal' });
    for (const mark of app.cell(3, 1).children.filter((child) => child.className === 'rr-mark')) {
      expect(mark.attributes.get('aria-hidden')).toBe('true');
    }
  });

  it('wears the same badge in the list, and the same mark beside each answer', async () => {
    const app = mountHarness();
    await settle();
    const item = byClass(app.root, 'rr-switch');
    expect(item.children[0]?.className).toBe('rr-badge rr-type-choice');
    expect(item.children[0]?.textContent).toBe('A');
    const lines = byClass(item, 'rr-exits').children;
    expect(
      lines.map((line) => [line.children[1]?.textContent, /--rr-art-mark-([\w-]+),/.exec(line.children[0]?.attributes.get('style') ?? '')?.[1]]),
    ).toEqual([
      ['coal', 'coal'],
      ['gold', 'gold'],
    ]);
  });

  it('lights the branch the cart took as it goes, and dims the rest', async () => {
    const app = await ready();
    expect(app.cell(3, 1).attributes.has('data-taken')).toBe(false);
    app.send.click();
    await settle();
    expect(app.cell(3, 1).attributes.get('data-taken')).toBe('E');
    expect(app.art(3, 1)).toBe('--art: var(--rr-art-branch-W-E, none), var(--rr-art-junction-dim-W-ES, none)');
    // The badge and the marks are still there, to read the dimmed ways against.
    expect(marksOf(app.cell(3, 1))).toEqual({ E: 'gold', S: 'coal' });
    expect(byClass(app.cell(3, 1), 'rr-badge').textContent).toBe('A');
  });

  it('lights the branch at once when motion is reduced', async () => {
    const app = await ready({ still: true });
    app.send.click();
    await settle();
    expect(app.cell(3, 1).attributes.get('data-taken')).toBe('E');
  });

  it('lights nothing at a switch the cart never left', async () => {
    const run: RunResponse = { ...ARRIVED, outcome: 'derailed', readings: [], stars: 0, path: ARRIVED.path.slice(0, 2) };
    const app = await ready({ runs: [{ status: 200, body: run }] });
    app.send.click();
    await settle();
    expect(app.cell(3, 1).attributes.has('data-taken')).toBe(false);
    expect(app.art(3, 1)).toBe('--art: var(--rr-art-junction-W-ES, none)');
  });

  it('puts the junction back as it was once the track is edited, or the next run is sent', async () => {
    const app = await ready({ runs: [{ status: 200, body: ARRIVED }, { status: 200, body: ARRIVED }, 'hang'] });
    app.send.click();
    await settle();
    app.cell(1, 1).click();
    expect(app.cell(3, 1).attributes.has('data-taken')).toBe(false);
    expect(app.art(3, 1)).toBe('--art: var(--rr-art-junction-W-ES, none)');

    app.send.click();
    await settle();
    expect(app.cell(3, 1).attributes.get('data-taken')).toBe('E');
    app.send.click();
    await settle();
    expect(app.cell(3, 1).attributes.has('data-taken')).toBe(false);
  });
});

describe('where a switch’s badge sits', () => {
  it('goes to a corner across from the entry, the top one when it can', () => {
    expect(badgeCorner({ entry: 'W' })).toBe('ne');
    expect(badgeCorner({ entry: 'E' })).toBe('nw');
    expect(badgeCorner({ entry: 'S' })).toBe('ne');
    expect(badgeCorner({ entry: 'N' })).toBe('se');
  });
});

describe('editing the track', () => {
  it('turns a rotatable piece on a click, and says so to a screen reader', async () => {
    const app = mountHarness();
    await settle();
    expect(app.art(1, 1)).toContain('straight-0');
    expect(app.cell(1, 1).attributes.get('aria-label')).toContain('turns');

    app.cell(1, 1).click();
    expect(app.art(1, 1)).toContain('straight-1');
    app.cell(1, 1).click();
    app.cell(1, 1).click();
    app.cell(1, 1).click();
    expect(app.art(1, 1)).toContain('straight-0');
  });

  it('leaves fixed pieces, rocks and switches alone', async () => {
    const app = mountHarness();
    await settle();
    const before = [app.art(0, 1), app.art(0, 0), app.art(3, 1), app.art(4, 1)];
    for (const [x, y] of [[0, 1], [0, 0], [3, 1], [4, 1]] as const) app.cell(x, y).click();
    expect([app.art(0, 1), app.art(0, 0), app.art(3, 1), app.art(4, 1)]).toEqual(before);
  });

  it('lays a piece from the crate: pick it, then the square', async () => {
    const app = mountHarness();
    await settle();
    const straight = app.tool('Straight');
    expect(straight.textContent).toBe('Straight ×1');
    expect(app.tool('Curve').disabled).toBe(true);

    straight.click();
    expect(straight.attributes.get('aria-pressed')).toBe('true');
    app.cell(2, 1).click();

    expect(app.art(2, 1)).toContain('straight-0');
    expect(app.cell(2, 1).attributes.get('aria-label')).toContain('laid by you');
    expect(app.tool('Straight').textContent).toBe('Straight ×0');
    // The crate ran out, so the hand goes back to turning: the next click on
    // the piece just laid turns it.
    expect(app.tool('Straight').attributes.get('aria-pressed')).toBe('false');
    app.cell(2, 1).click();
    expect(app.art(2, 1)).toContain('straight-1');
  });

  it('does not mark an empty square as fixed, before a piece is laid on it or after it is taken back', async () => {
    const app = mountHarness();
    await settle();
    expect(app.cell(2, 1).attributes.has('data-mode')).toBe(false);
    app.tool('Straight').click();
    app.cell(2, 1).click();
    expect(app.cell(2, 1).attributes.get('data-mode')).toBe('placed');
    app.cell(2, 1).press('Delete');
    expect(app.cell(2, 1).attributes.has('data-mode')).toBe(false);
    expect(app.cell(0, 0).attributes.get('data-mode')).toBe('fixed');
  });

  it('will not lay a piece on a rock or over another piece', async () => {
    const app = mountHarness();
    await settle();
    app.tool('Straight').click();
    app.cell(0, 0).click();
    app.cell(4, 1).click();
    expect(app.tool('Straight').textContent).toBe('Straight ×1');
  });

  it('takes a laid piece back to the crate, with the tool or with Delete', async () => {
    const app = mountHarness();
    await settle();
    app.tool('Straight').click();
    app.cell(2, 1).click();
    expect(app.tool('Take back').disabled).toBe(false);

    app.tool('Take back').click();
    app.cell(2, 1).click();
    expect(app.art(2, 1)).toBe('');
    expect(app.tool('Straight').textContent).toBe('Straight ×1');

    app.tool('Straight').click();
    app.cell(2, 0).click();
    app.cell(2, 0).press('Delete');
    expect(app.tool('Straight').textContent).toBe('Straight ×1');
    // A piece of the level is not the player's to take.
    app.cell(1, 1).press('Delete');
    expect(app.art(1, 1)).toContain('straight-0');
  });

  it('moves the focus around the board with the arrow keys, one tab stop at a time', async () => {
    const app = mountHarness();
    await settle();
    expect(app.cell(0, 0).tabIndex).toBe(0);
    expect(app.cell(1, 0).tabIndex).toBe(-1);

    app.cell(0, 0).press('ArrowRight');
    app.cell(1, 0).press('ArrowDown');
    expect(app.doc.focused).toBe(app.cell(1, 1));
    expect(app.cell(1, 1).tabIndex).toBe(0);
    expect(app.cell(0, 0).tabIndex).toBe(-1);

    app.cell(1, 1).press('ArrowUp');
    app.cell(1, 0).press('ArrowUp');
    expect(app.doc.focused).toBe(app.cell(1, 0));
  });

  it('moves the one tab stop to a square that is clicked', async () => {
    const app = mountHarness();
    await settle();
    const stops = (): FakeElement[] => descendants(app.root).filter((node) => node.className === 'rr-cell' && node.tabIndex === 0);

    app.cell(2, 1).click();
    expect(stops()).toEqual([app.cell(2, 1)]);
    app.cell(2, 1).press('ArrowRight');
    expect(stops()).toEqual([app.cell(3, 1)]);
  });
});

describe('the note', () => {
  it('counts the words as the backend does, against the level’s limit', async () => {
    const app = mountHarness();
    await settle();
    const counter = byId(app.root, 'rr-sentence-count');
    expect(counter.textContent).toBe('0 / 5 words');
    app.type("don't, well-known mine cart");
    expect(counter.textContent).toBe('5 / 5 words');
    expect(counter.attributes.get('data-over')).toBe('false');
    app.type('one two three four five six');
    expect(counter.attributes.get('data-over')).toBe('true');
    expect(app.text()).toContain('1 word over the limit');
  });

  it('warns about a forbidden word while it is there, and the warning goes when it does', async () => {
    const app = mountHarness();
    await settle();
    app.type('Golden nuggets');
    expect(app.text()).toContain('It uses a forbidden word: gold.');
    app.type('Shiny nuggets');
    expect(byId(app.root, 'rr-sentence-warning').textContent).toBe('');
  });

  it('asks for a note instead of sending an empty one', async () => {
    const app = mountHarness();
    await settle();
    app.type('   ');
    app.send.click();
    await settle();
    expect(app.sent).toEqual([]);
    expect(app.text()).toContain(UI_TEXT.emptySentence);
  });

  it('asks for a note instead of sending one with no word in it', async () => {
    for (const note of ['!!!', '\u200b', ' \u00ad\ufe0f\u3164 ']) {
      const app = mountHarness();
      await settle();
      app.type(note);
      app.send.click();
      await settle();
      expect(app.sent).toEqual([]);
      expect(app.text()).toContain(UI_TEXT.emptySentence);
    }
  });

  it('counts and warns about a forbidden word hidden by an invisible character or styled letters', async () => {
    const app = mountHarness();
    await settle();
    app.type('go\u00adld nuggets');
    expect(byId(app.root, 'rr-sentence-count').textContent).toBe('2 / 5 words');
    expect(app.text()).toContain('It uses a forbidden word: gold.');
    app.type('𝐆𝐎𝐋𝐃 nuggets');
    expect(app.text()).toContain('It uses a forbidden word: gold.');
  });
});

describe('sending the cart', () => {
  it('posts the level, the note as typed and only the edits to /api/run', async () => {
    const app = await ready();
    app.cell(1, 1).click();
    app.tool('Straight').click();
    app.cell(2, 1).click();
    app.send.click();
    await settle();

    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.url).toBe('/api/run');
    expect(app.sent[0]?.method).toBe('POST');
    expect(app.sent[0]?.headers['content-type']).toBe('application/json');
    expect(app.sent[0]?.headers['x-typesafe-key']).toBeUndefined();
    expect(app.request()).toEqual({
      level_id: 'first-switch',
      sentence: 'A heavy load of nuggets',
      rotations: [{ x: 1, y: 1, rotation: 1 }],
      placements: [{ x: 2, y: 1, kind: 'straight', rotation: 0 }],
    });
  });

  it('rolls the cart square by square, a frame each, and ends it the way the run ended', async () => {
    const app = await ready();
    app.send.click();
    await settle();

    expect(app.waits).toEqual(ARRIVED.path.map(() => FRAME_MS));
    expect(app.cart.hidden).toBe(false);
    expect(app.cart.attributes.get('style')).toBe('--cx: 4; --cy: 1');
    expect(app.cart.attributes.get('data-end')).toBe('arrived');
    for (const step of ARRIVED.path) expect(app.cell(step.x, step.y).attributes.has('data-trail')).toBe(true);
    expect(app.cell(0, 0).attributes.has('data-trail')).toBe(false);
  });

  it('brings the board into view before the cart rolls, and only for a run that rolls', async () => {
    const app = await ready({ runs: [{ status: 502, body: { error: 'jev_unavailable', detail: '' } }, { status: 200, body: ARRIVED }] });
    const well = byClass(app.root, 'rr-viewport');
    app.send.click();
    await settle();
    expect(well.scrolled).toEqual([]);

    const order: string[] = [];
    const scrollIntoView = well.scrollIntoView.bind(well);
    well.scrollIntoView = (options?: unknown) => {
      order.push(`scrolled with ${JSON.stringify(options)} at step ${String(app.waits.length)}`);
      scrollIntoView(options);
    };
    app.send.click();
    await settle();
    expect(order).toEqual(['scrolled with {"block":"nearest","behavior":"smooth"} at step 0']);
  });

  it('brings the board into view at once when motion is reduced', async () => {
    const app = await ready({ still: true });
    app.send.click();
    await settle();
    expect(byClass(app.root, 'rr-viewport').scrolled).toEqual([{ block: 'nearest', behavior: 'auto' }]);
  });

  it('puts the cart straight where it stopped when motion is reduced', async () => {
    const app = await ready({ still: true });
    app.send.click();
    await settle();

    expect(app.waits).toEqual([]);
    expect(app.cart.attributes.get('style')).toBe('--cx: 4; --cy: 1');
    expect(app.cart.attributes.get('data-end')).toBe('arrived');
    for (const step of ARRIVED.path) expect(app.cell(step.x, step.y).attributes.has('data-trail')).toBe(true);
  });

  it('says how it ended, shows what each switch read, the stars and the quota', async () => {
    const app = await ready();
    app.send.click();
    await settle();

    expect(app.status.textContent).toBe('The cart rolled into the mine. 2 of 3 stars.');
    const shown = shownText(app.readings);
    expect(shown).toContain('A · What does the cart carry?');
    expect(shown).toContain('Chose “gold”, 93% sure. Clear call.');
    expect(shown).toContain('★★☆');
    expect(app.quota.textContent).toBe('Free runs left today: 7.');
  });

  it('reads each kind of switch in its own terms', async () => {
    const run: RunResponse = {
      ...ARRIVED,
      outcome: 'wrong_tunnel',
      readings: [
        { switch_id: 'danger', type: 'noul', result: 'yes', confidence: null, noul: 0.55, threshold: 0.5, score: null, margin: 0.05, clean: false },
      ],
      stars: 0,
      cached: true,
    };
    const app = mountHarness({ runs: [{ status: 200, body: run }] });
    await settle();
    app.picker.value = 'the-gate';
    app.picker.fire('change');
    app.type('a box of fireworks');
    app.send.click();
    await settle();

    expect(app.text()).toContain('Answered yes: 0.55 against a bar of 0.50. Close call: Jev was near the edge.');
    expect(app.text()).toContain('wrong tunnel');
    expect(app.quota.textContent).toContain('no run was spent');
  });

  it('says the cart met no switch when it came off before one', async () => {
    const run: RunResponse = { ...ARRIVED, outcome: 'derailed', readings: [], stars: 0, path: ARRIVED.path.slice(0, 2) };
    const app = await ready({ runs: [{ status: 200, body: run }] });
    app.send.click();
    await settle();
    expect(app.text()).toContain(UI_TEXT.noReadings);
    expect(app.text()).toContain('came off the track');
    expect(app.cart.attributes.get('data-end')).toBe('derailed');
  });

  it('keeps the best stars of the level, and the picker shows them', async () => {
    const app = await ready();
    app.send.click();
    await settle();
    expect(JSON.parse(app.store.items.get(STARS_ITEM) ?? '{}')).toEqual({ 'first-switch': 2 });
    expect(app.picker.children[0]?.textContent).toBe('1. First Switch ★★');
  });

  it('plays on, stars and all, when the browser lends no storage', async () => {
    const blocked: ProgressStore = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    const app = await ready({ storage: blocked });
    app.send.click();
    await settle();
    expect(app.failure.hidden).toBe(true);
    expect(app.status.textContent).toContain('rolled into the mine');
    expect(app.picker.children[0]?.textContent).toBe('1. First Switch ★★');
  });

  it('keeps the stars of every level played this visit when the browser lends no storage', async () => {
    const blocked: ProgressStore = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    const app = await ready({ storage: blocked });
    app.send.click();
    await settle();
    app.picker.value = 'the-gate';
    app.picker.fire('change');
    app.type('a box of fireworks');
    app.send.click();
    await settle();
    expect(app.picker.children.map((option) => option.textContent)).toEqual(['1. First Switch ★★', '2. The Gate ★★']);
  });

  it('takes the last run off the board once the track is edited', async () => {
    const app = await ready();
    app.send.click();
    await settle();
    app.cell(1, 1).click();
    expect(app.cart.hidden).toBe(true);
    expect(app.cell(0, 1).attributes.has('data-trail')).toBe(false);
  });

  it('leaves the last run behind when another level is picked', async () => {
    const run: RunResponse = { ...ARRIVED, outcome: 'derailed', readings: [], stars: 0, path: ARRIVED.path.slice(0, 2) };
    const app = await ready({ runs: [{ status: 200, body: run }] });
    app.send.click();
    await settle();
    expect(app.cart.attributes.get('data-end')).toBe('derailed');

    app.picker.value = 'the-gate';
    app.picker.fire('change');
    expect(app.cart.hidden).toBe(true);
    expect(app.cart.attributes.has('data-end')).toBe(false);
    expect(app.cell(1, 1).attributes.has('data-trail')).toBe(false);
    expect(shownText(app.readings)).not.toContain('☆');
    expect(shownText(app.readings)).toContain(UI_TEXT.readingsBefore);
  });

  it('takes the last run off the board as soon as the next one is sent, before the answer comes', async () => {
    const app = await ready({ runs: [{ status: 200, body: ARRIVED }, 'hang'] });
    app.send.click();
    await settle();
    expect(app.cart.hidden).toBe(false);
    expect(shownText(app.readings)).toContain('★★☆');

    app.send.click();
    await settle();
    expect(app.cart.hidden).toBe(true);
    expect(app.cart.attributes.has('data-end')).toBe(false);
    for (const step of ARRIVED.path) expect(app.cell(step.x, step.y).attributes.has('data-trail')).toBe(false);
    expect(shownText(app.readings)).not.toContain('☆');
    expect(shownText(app.readings)).toContain(UI_TEXT.readingsBefore);
  });

  it('leaves nothing of the last run up when the next one is refused', async () => {
    for (const answer of [
      { status: 422, body: { error: 'taboo', detail: 'forbidden on this level: gold' } },
      { status: 429, body: { error: 'quota_exhausted', detail: '' } },
      { status: 401, body: { error: 'key_rejected', detail: '' } },
      { status: 502, body: { error: 'jev_unavailable', detail: '' } },
    ] as Answer[]) {
      const app = await ready({ runs: [{ status: 200, body: ARRIVED }, answer] });
      app.send.click();
      await settle();
      app.send.click();
      await settle();
      expect(app.failure.hidden).toBe(false);
      expect(app.cart.hidden).toBe(true);
      expect(app.cell(0, 1).attributes.has('data-trail')).toBe(false);
      expect(shownText(app.readings)).not.toContain('☆');
    }
  });

  it('holds every control while the cart is out, and ignores a second click', async () => {
    const app = await ready({ runs: ['hang'] });
    app.send.click();
    await settle();

    expect(app.send.disabled).toBe(true);
    expect(app.send.textContent).toBe(UI_TEXT.sending);
    expect(app.picker.disabled).toBe(true);
    app.send.click();
    app.cell(1, 1).click();
    await settle();
    expect(app.sent).toHaveLength(1);
    expect(app.art(1, 1)).toContain('straight-0');
  });
});

describe('when the run is refused or fails', () => {
  it('names the forbidden word the backend found', async () => {
    const app = await ready({
      runs: [{ status: 422, body: { error: 'taboo', detail: 'forbidden on this level: gold' } }],
    });
    app.send.click();
    await settle();
    expect(app.text()).toContain('The note uses a forbidden word. Say it another way and send the cart again.');
    expect(app.text()).toContain('forbidden on this level: gold');
    expect(app.send.disabled).toBe(false);
  });

  it('says when the note has too many words', async () => {
    const app = await ready({
      runs: [{ status: 422, body: { error: 'too_many_words', detail: 'the sentence has 9 words and this level allows 5' } }],
    });
    app.send.click();
    await settle();
    expect(app.text()).toContain('too many words for this level');
    expect(app.text()).toContain('this level allows 5');
  });

  it('turns any other refusal of the rules into a sentence too', async () => {
    const app = await ready({ runs: [{ status: 422, body: { error: 'something_new', detail: '' } }] });
    app.send.click();
    await settle();
    expect(app.text()).toContain('The server refused the run.');
  });

  it('opens the key field once the free runs are spent', async () => {
    const app = await ready({ runs: [{ status: 429, body: { error: 'quota_exhausted', detail: 'no free runs left today' } }] });
    expect(app.keyField.hidden).toBe(true);
    app.send.click();
    await settle();
    expect(app.keyField.hidden).toBe(false);
    expect(app.keyField.scrolled).toEqual([{ block: 'nearest', behavior: 'smooth' }]);
    expect(app.text()).toContain('Paste your own TypeSafe key');
  });

  it('says no free runs are left once they are spent, whatever the last run said', async () => {
    const app = await ready({ runs: [{ status: 200, body: ARRIVED }, { status: 429, body: { error: 'quota_exhausted', detail: '' } }] });
    app.send.click();
    await settle();
    expect(app.quota.textContent).toBe('Free runs left today: 7.');
    app.send.click();
    await settle();
    expect(app.quota.textContent).toBe('Free runs left today: 0.');
  });

  it('says a refused key was refused', async () => {
    const app = await ready({ runs: [{ status: 401, body: { error: 'key_rejected', detail: 'the key was refused' } }] });
    app.send.click();
    await settle();
    expect(app.text()).toContain('TypeSafe turned the key down. Check the key and send the cart again.');
  });

  it('says to try again when Jev did not answer', async () => {
    const app = await ready({ runs: [{ status: 502, body: { error: 'jev_unavailable', detail: 'Jev did not answer' } }] });
    app.send.click();
    await settle();
    expect(app.text()).toContain('Jev did not answer this time. Wait a moment and send the cart again.');
  });

  it('says the server could not be reached', async () => {
    const app = await ready({ runs: ['network'] });
    app.send.click();
    await settle();
    expect(app.text()).toContain(UI_TEXT.networkFailed);
    expect(app.send.disabled).toBe(false);
  });

  it('does not animate an answer it cannot read', async () => {
    for (const answer of [
      { status: 500, body: 'Internal Server Error' },
      { status: 200, body: { outcome: 'arrived' } },
    ]) {
      const app = await ready({ runs: [answer] });
      app.send.click();
      await settle();
      expect(app.text()).toContain(UI_TEXT.unexpected);
      expect(app.cart.hidden).toBe(true);
    }
  });

  it('reveals the failure region before it puts the failure into it', async () => {
    const app = await ready({ runs: [{ status: 502, body: { error: 'jev_unavailable', detail: '' } }] });
    app.send.click();
    await settle();
    expect(app.failure.trace.slice(-2)).toEqual(['revealed', 'filled:1']);
  });

  it('clears the failure when the next run goes through', async () => {
    const app = await ready({ runs: ['network', { status: 200, body: ARRIVED }] });
    app.send.click();
    await settle();
    expect(app.failure.hidden).toBe(false);
    app.send.click();
    await settle();
    expect(app.failure.hidden).toBe(true);
    expect(app.failure.children).toEqual([]);
  });
});

describe('the visitor’s own key stays in its field', () => {
  async function withKey() {
    const app = await ready({
      runs: [{ status: 429, body: { error: 'quota_exhausted', detail: '' } }, { status: 200, body: { ...ARRIVED, quota: { remaining: null, byok: true } } }],
    });
    app.send.click();
    await settle();
    app.key.value = '  ts-visitor-secret-key\n';
    app.send.click();
    await settle();
    return app;
  }

  it('hides the key as it is typed, gives the field no name, and builds no form', () => {
    const app = mountHarness();
    expect(app.key.type).toBe('password');
    expect((app.key as unknown as Record<string, unknown>)['name']).toBeUndefined();
    expect(descendants(app.root).map((node) => node.tagName)).not.toContain('form');
  });

  it('sends it in the x-typesafe-key header, and only there', async () => {
    const app = await withKey();
    expect(app.sent).toHaveLength(2);
    expect(app.sent[1]?.headers['x-typesafe-key']).toBe('ts-visitor-secret-key');
    expect(app.sent[1]?.url).toBe('/api/run');
    expect(app.sent[1]?.body).not.toContain('ts-visitor-secret-key');
    expect(app.quota.textContent).toBe('Running on your own key.');
  });

  it('refuses a key with a character no key has, says what to do, and sends nothing', async () => {
    for (const pasted of ['ts-visitor\u200bsecret', '“ts-visitor-secret”', 'ts visitor secret', 'ts-visitor-sécret']) {
      const app = await ready({ runs: [{ status: 429, body: { error: 'quota_exhausted', detail: '' } }, { status: 200, body: ARRIVED }] });
      app.send.click();
      await settle();
      app.key.value = pasted;
      app.send.click();
      await settle();
      expect(app.sent).toHaveLength(1);
      expect(app.failure.hidden).toBe(false);
      expect(app.text()).toContain(UI_TEXT.keyInvalid);
      expect(app.text()).not.toContain('secret');
      expect(app.send.disabled).toBe(false);
    }
  });

  it('never stores it, and never shows it', async () => {
    const app = await withKey();
    for (const value of app.store.items.values()) expect(value).not.toContain('secret');
    expect(app.text()).not.toContain('ts-visitor-secret-key');
  });

  it('never shows it in a failure, on any path a run with the key can end', async () => {
    for (const answer of [
      'network',
      { status: 401, body: { error: 'key_rejected', detail: 'the key was refused' } },
      { status: 422, body: { error: 'taboo', detail: 'forbidden on this level: gold' } },
      { status: 429, body: { error: 'quota_exhausted', detail: 'no free runs left today' } },
      { status: 502, body: { error: 'jev_unavailable', detail: 'Jev did not answer' } },
      { status: 500, body: 'Internal Server Error' },
      { status: 200, body: { outcome: 'arrived' } },
    ] as Answer[]) {
      const app = await ready({ runs: [{ status: 429, body: { error: 'quota_exhausted', detail: '' } }, answer] });
      app.send.click();
      await settle();
      app.key.value = 'ts-visitor-secret-key';
      app.send.click();
      await settle();
      expect(app.sent[1]?.headers['x-typesafe-key']).toBe('ts-visitor-secret-key');
      expect(app.failure.hidden).toBe(false);
      expect(app.text()).not.toContain('secret');
    }
  });

  it('writes nothing to the console, on any path', async () => {
    const logged = await withTrappedConsole(async () => {
      for (const runs of [
        [{ status: 200, body: ARRIVED }],
        [{ status: 422, body: { error: 'taboo', detail: 'forbidden on this level: gold' } }],
        [{ status: 429, body: { error: 'quota_exhausted', detail: '' } }],
        [{ status: 401, body: { error: 'key_rejected', detail: '' } }],
        [{ status: 502, body: { error: 'jev_unavailable', detail: '' } }],
        ['network'],
      ] as Answer[][]) {
        const app = await ready({ runs });
        app.key.value = 'ts-visitor-secret-key';
        app.send.click();
        await settle();
      }
      await withKey();
    });
    expect(logged).toEqual([]);
  });
});

describe('what the page says it is doing', () => {
  it('says Jev is reading while the run is out', async () => {
    const app = await ready({ runs: ['hang'] });
    app.send.click();
    await settle();
    expect(app.status.textContent).toBe(UI_TEXT.rolling);
  });

  it('says the cart is on the track while it rolls', async () => {
    const app = await ready();
    const writes = watchText(app.status);
    app.send.click();
    await settle();
    expect(writes).toEqual([UI_TEXT.rolling, UI_TEXT.onTrack, 'The cart rolled into the mine. 2 of 3 stars.']);
  });

  it('writes the status line once per change, not once per call', async () => {
    const app = await ready();
    const writes = watchText(app.status);
    app.picker.value = 'first-switch';
    app.picker.fire('change');
    app.picker.fire('change');
    expect(writes).toEqual([]);
  });
});

// --- The scenery ------------------------------------------------------------------

/** Runs `work` with `doc` standing in for the browser's window and document, as `art.ts` reaches for them. */
function asBrowser(doc: FakeDocument, work: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g['window'], document: g['document'] };
  g['window'] = doc.defaultView;
  g['document'] = doc;
  try {
    work();
  } finally {
    g['window'] = saved.window;
    g['document'] = saved.document;
  }
}

describe('the mine around the game', () => {
  /** A page with the levels in and a note written, then dressed; `added` is every element the scene put in. */
  async function dressed(options: { drawing?: boolean; still?: boolean } = {}) {
    const app = await ready();
    app.doc.drawing = options.drawing ?? true;
    app.doc.still = options.still ?? false;
    const before = new Set(descendants(app.root));
    asBrowser(app.doc, () => {
      dressScene(app.root as unknown as HTMLElement);
    });
    return { ...app, added: descendants(app.root).filter((node) => !before.has(node)) };
  }

  const named = (nodes: readonly FakeElement[], className: string): FakeElement[] =>
    nodes.filter((node) => node.className.split(' ').includes(className));

  it('draws every picture the board, the switches and the list ask for, a run’s lit branches too', async () => {
    const app = await dressed();
    app.send.click();
    await settle();
    const drawn = app.doc.documentElement.style.props;
    expect(app.doc.documentElement.attributes.has('data-art')).toBe(true);

    const asked = new Set<string>();
    for (const node of descendants(app.root)) {
      for (const [, name] of (node.attributes.get('style') ?? '').matchAll(/--rr-art-([\w-]+)/g)) asked.add(name ?? '');
      const type = /rr-type-(\w+)/.exec(node.className)?.[1];
      if (type !== undefined) asked.add(`type-${type}`);
    }
    expect(asked).toContain('branch-W-E');
    expect(asked).toContain('junction-dim-W-ES');
    expect(asked).toContain('mark-gold');
    expect(asked).toContain('type-choice');
    for (const name of asked) expect(drawn.has(`--rr-art-${name}`), name).toBe(true);
    for (const mark of exitMarkNames()) expect(drawn.has(`--rr-art-mark-${mark}`), mark).toBe(true);
    for (const type of ['choice', 'noul', 'score']) expect(drawn.has(`--rr-art-type-${type}`), type).toBe(true);
    for (const texture of ['earth', 'floor', 'beam', 'post']) expect(drawn.get(`--rr-art-${texture}`)).toMatch(/^url\(data:image\/png/);
  });

  it('frames the boards in a timbered tunnel mouth: dark rock behind them, a post each side, the cap over it', async () => {
    const app = await dressed();
    const shell = byClass(app.root, 'rr-app');
    expect(shell.children[0]?.className).toBe('rr-side l');
    expect(shell.children[1]?.className).toBe('rr-side r');
    expect(shell.children[2]?.className).toBe('rr-tunnel');
    expect(shell.children[3]?.className).toBe('rr-beam');
    const tunnel = shell.children[2]!;
    expect(named(tunnel.children, 'rr-post').map((post) => post.className)).toEqual(['rr-post l', 'rr-post r']);
    expect(named(tunnel.children, 'rr-brace')).toHaveLength(2);
    expect(named(tunnel.children, 'rr-post-lamp')).toHaveLength(2);
  });

  it('hangs a lamp either side of the plaque, in the order the hall’s grid places them', async () => {
    const app = await dressed();
    const hall = byClass(app.root, 'rr-hall');
    const order = hall.children.filter((node) => !node.className.includes('rr-prop')).map((node) => node.className);
    expect(order).toEqual(['rr-lantern-wrap l', 'rr-plaque', 'rr-lantern-wrap r']);
  });

  it('puts the mine’s things on the earth to either side, ore in the rock, and a bolt in every corner of each board', async () => {
    const app = await dressed();
    const props = named(app.added, 'rr-prop');
    expect(props.length).toBeGreaterThan(0);
    for (const side of named(app.added, 'rr-side')) expect(named(descendants(side), 'rr-floor-row')).toHaveLength(1);
    for (const board of named(descendants(app.root), 'rr-board')) {
      expect(named(board.children, 'rr-bolt').map((bolt) => bolt.className)).toEqual(['rr-bolt tl', 'rr-bolt tr', 'rr-bolt bl', 'rr-bolt br']);
    }
    expect(named(app.added, 'rr-floor')).toHaveLength(1);
    expect(named(app.added, 'rr-rat')).toHaveLength(1);
  });

  it('adds nothing a screen reader reads or the keyboard stops on', async () => {
    const app = await dressed();
    expect(app.added.length).toBeGreaterThan(30);
    for (const node of app.added) {
      expect(node.attributes.get('aria-hidden'), node.className).toBe('true');
      expect(node.tabIndex, node.className).toBe(-1);
      expect(['button', 'input', 'select', 'textarea', 'a']).not.toContain(node.tagName);
    }
    expect(app.added.map((node) => node.textContent).join('')).toBe('');
  });

  it('flickers its lamps a frame at a time, and holds them still when motion is reduced', async () => {
    expect((await dressed()).doc.intervals).toEqual([FRAME_MS]);
    expect((await dressed({ still: true })).doc.intervals).toEqual([]);
  });

  it('gives up whole when the browser will not draw: no art, no scenery, the game as it was', async () => {
    const app = await dressed({ drawing: false });
    expect(app.added).toEqual([]);
    expect(app.doc.documentElement.attributes.has('data-art')).toBe(false);
    expect(app.doc.documentElement.style.props.size).toBe(0);
    // The board still shows a character for every piece, and plays.
    expect(app.cell(3, 1).children[0]?.textContent).toBe('◆');
    app.send.click();
    await settle();
    expect(app.cart.attributes.get('data-end')).toBe('arrived');
  });
});
