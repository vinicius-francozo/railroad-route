import { describe, expect, it } from 'vitest';

import type { PublicLevel, RunRequest, RunResponse } from './contract';
import { UI_TEXT } from './messages';
import { mount, mountApp } from './mount';
import type { AppServices } from './mount';
import { STARS_ITEM } from './progress';
import type { ProgressStore } from './progress';
import { FRAME_MS } from './style';

// --- A document, by hand -----------------------------------------------------
//
// Vitest runs under `environment: 'node'`, so there is no DOM here and no jsdom
// to reach for. The page is written against a small slice of the document —
// create an element, set a property or an attribute, append, replace, listen —
// and that slice is small enough to stand in for honestly. What it cannot stand
// in for is layout and drawing, and this file asserts nothing about either.

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
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
    this.trace.push(`filled:${String(nodes.length)}`);
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
    expect(app.art(3, 1)).toContain('--rr-art-junction-W-ES');
    expect(app.art(3, 1)).toContain('--rr-art-device-choice');
    expect(app.art(4, 1)).toContain('--rr-art-mine-0');
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
    expect(app.art(3, 1)).toContain('--rr-art-device-noul');
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
    app.type("don't, well-known cart");
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
