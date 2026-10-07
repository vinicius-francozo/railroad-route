/**
 * The page: the only module in this project that touches the document.
 *
 * Everything decidable was decided somewhere else — the board's rules in
 * `game.ts`, the wording in `messages.ts`, the stars in `progress.ts` — and
 * each of those is a pure module with its own tests. What is left here is
 * building elements, reading fields and putting text into them.
 *
 * The run itself is the backend's. The page sends the level, the note and the
 * player's edits to `POST /api/run`, and animates the path that comes back; it
 * never works out where the cart goes.
 *
 * The visitor's own TypeSafe key, once the free runs are spent, lives in its
 * field and nowhere else. It is read at the moment a run is sent and goes in
 * the `x-typesafe-key` header of that one request: never in the body, never in
 * the URL (no form is built here and nothing writes to `location`), never in
 * storage, and never in a log, because nothing in `src/` calls `console` and
 * every handler below catches what it starts.
 */

import type { PlaceableKind, PublicLevel, RunResponse, Side } from './contract';
import { newGame, PLACEABLE, place, piecesLaid, runRequest, squareAt, stock, tabooHits, takeBack, turn, countWords } from './game';
import type { Edit, Game, Square } from './game';
import {
  crateLabel,
  describeOutcome,
  describeQuota,
  describeReading,
  describeRunError,
  describeSquare,
  exitLines,
  levelOption,
  levelRules,
  noteWarning,
  starMarks,
  starWords,
  switchKind,
  switchLetter,
  tabooLine,
  UI_TEXT,
  wordCount,
} from './messages';
import type { Failure } from './messages';
import { browserStore, nullStore, readStars, recordStars } from './progress';
import type { ProgressStore, Stars } from './progress';
import { dressScene } from './scene';
import { FRAME_MS, STYLE } from './style';

/** The part of `fetch` the page uses, so a test can answer in its place. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Everything the page reaches for outside itself.
 *
 * It exists so `mount.test.ts` can drive the page without a network, a clock
 * or a browser. In production every one is the real thing.
 */
export type AppServices = {
  fetch: Fetch;
  /** Where the stars are remembered between visits. */
  storage: ProgressStore;
  /** Whether the person asked for stillness: the cart then appears where it stopped. */
  reducedMotion: () => boolean;
  /** Waits one frame of the cart's journey. */
  wait: (ms: number) => Promise<void>;
};

function defaultServices(doc: Document): AppServices {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    storage: browserStore() ?? nullStore(),
    reducedMotion: () => doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? true,
    wait: (ms) =>
      new Promise((done) => {
        setTimeout(done, ms);
      }),
  };
}

/**
 * Mounts the game into `root`, then dresses the room around it.
 *
 * The scenery comes after and only here: `mountApp` builds nothing but what a
 * person reads and operates, so the tests that drive it see the page and none
 * of the decoration, and a scene that fails to draw leaves the game whole.
 */
export function mount(root: HTMLElement): void {
  mountApp(root, {});
  dressScene(root);
}

/** Which tool the board's clicks use: turning, laying one kind, or taking back. */
type Tool = 'turn' | PlaceableKind | 'takeback';

/** The art a square wears, as the custom properties `scene.ts` defines. */
function squareArt(square: Square): string {
  switch (square.kind) {
    case 'empty':
      return '';
    case 'switch': {
      const order: readonly Side[] = ['N', 'E', 'S', 'W'];
      const exits = order.filter((side) => Object.values(square.switch.exits).includes(side)).join('');
      return `--art: var(--rr-art-junction-${square.switch.entry}-${exits}, none); --dev: var(--rr-art-device-${square.switch.question.type}, none)`;
    }
    case 'piece':
      return square.piece === 'rock' ? '--art: var(--rr-art-rock, none)' : `--art: var(--rr-art-${square.piece}-${String(square.rotation)}, none)`;
    default: {
      const unreachable: never = square;
      throw new TypeError(`unknown square: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * A character that stands for the square when no art could be drawn.
 *
 * Under the sprite, and hidden by the stylesheet once `scene.ts` has drawn the
 * art, so a browser that would not draw still shows a track that can be played.
 */
function squareGlyph(square: Square): string {
  if (square.kind === 'empty') return '';
  if (square.kind === 'switch') return '◆';
  const r = square.rotation;
  switch (square.piece) {
    case 'straight':
      return r % 2 === 0 ? '│' : '─';
    case 'curve':
      return ['└', '┌', '┐', '┘'][r] ?? '└';
    case 'cross':
      return '┼';
    case 'start':
      return ['▸', '▾', '◂', '▴'][r] ?? '▸';
    case 'mine':
      return '⌂';
    case 'tunnel':
      return '∩';
    case 'rock':
      return '●';
    default: {
      const unreachable: never = square.piece;
      throw new TypeError(`unknown piece: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Does `value` look like the answer of a run, enough to animate it? */
function isRunResponse(value: unknown): value is RunResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['outcome'] === 'string' &&
    Array.isArray(v['path']) &&
    Array.isArray(v['readings']) &&
    typeof v['stars'] === 'number' &&
    typeof v['quota'] === 'object' &&
    v['quota'] !== null
  );
}

/**
 * Mounts with `overrides` standing in for parts of the environment.
 *
 * Separate from `mount` rather than an optional parameter, because `mount`'s
 * signature is what `main.ts` calls, with one argument.
 */
export function mountApp(root: HTMLElement, overrides: Partial<AppServices>): void {
  const doc = root.ownerDocument;
  const services: AppServices = { ...defaultServices(doc), ...overrides };

  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    if (className !== undefined) element.className = className;
    return element;
  };
  /** An element that wears an icon as a CSS background on `::before`, never as a child. */
  const iconClass = (base: string, icon: string): string => `${base} rr-icon rr-icon-${icon}`;

  const field = (id: string, label: string, icon: string): { wrap: HTMLDivElement; caption: HTMLLabelElement } => {
    const wrap = make('div', 'rr-field');
    const caption = make('label', iconClass('rr-label', icon));
    caption.htmlFor = id;
    caption.textContent = label;
    wrap.append(caption);
    return { wrap, caption };
  };

  // --- The shell -------------------------------------------------------------

  const style = make('style');
  style.textContent = STYLE;

  const app = make('div', 'rr-app');
  const hall = make('header', 'rr-hall');
  const plaque = make('div', 'rr-plaque');
  const brand = make('div', 'rr-brand');
  const heading = make('h1');
  heading.textContent = UI_TEXT.title;
  brand.append(heading);
  const tagline = make('p', 'rr-tagline');
  tagline.textContent = UI_TEXT.tagline;
  plaque.append(brand, tagline);
  hall.append(plaque);

  // --- The plan: level, switches, note, the button ------------------------------

  const levelField = field('rr-level', UI_TEXT.levelLabel, 'pickaxe').wrap;
  const levelPicker = make('select');
  levelPicker.id = 'rr-level';
  levelPicker.disabled = true;
  const levelNote = make('p', 'rr-note');
  levelNote.id = 'rr-level-rules';
  levelField.append(levelPicker, levelNote);

  // A level's forbidden words can run to dozens of terms, too many to keep on
  // screen under the note: they close the scrolling part instead, right above
  // the note's field, and the note still points at them.
  const taboo = make('p', 'rr-note rr-taboo');
  taboo.id = 'rr-sentence-taboo';

  const switchesBlock = make('div', 'rr-switches');
  const switchesHeading = make('h3');
  switchesHeading.textContent = UI_TEXT.switchesHeading;
  const switchesList = make('ul');
  switchesBlock.append(switchesHeading, switchesList);
  switchesBlock.hidden = true;

  const sentenceField = field('rr-sentence', UI_TEXT.sentenceLabel, 'scroll').wrap;
  const sentence = make('textarea');
  sentence.id = 'rr-sentence';
  sentence.rows = 3;
  sentence.placeholder = UI_TEXT.sentencePlaceholder;
  sentence.spellcheck = false;
  const counter = make('p', 'rr-count');
  counter.id = 'rr-sentence-count';
  // A warning while the note breaks a rule. Not a live region: it changes on
  // every keystroke, and the field already points at it for when it is read.
  const warning = make('p', 'rr-warning');
  warning.id = 'rr-sentence-warning';
  sentence.setAttribute('aria-describedby', 'rr-sentence-count rr-sentence-taboo rr-sentence-warning');
  sentenceField.append(sentence, counter, warning);

  const sendButton = make('button', iconClass('rr-go', 'cart'));
  sendButton.type = 'button';
  sendButton.textContent = UI_TEXT.send;

  const keyField = field('rr-key', UI_TEXT.keyLabel, 'key').wrap;
  const keyInput = make('input');
  keyInput.id = 'rr-key';
  // `password` so the key is not readable over a shoulder or in a screen share,
  // `off` so the browser does not offer to keep it. No `name`: a named control
  // is what a form serialises into a query string, and there is no form here.
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = UI_TEXT.keyPlaceholder;
  const keyNote = make('p', 'rr-note');
  keyNote.textContent = UI_TEXT.keyNote;
  keyField.append(keyInput, keyNote);
  // Shown only once the free runs are spent: before that there is nothing to paste.
  keyField.hidden = true;

  const failure = make('div', 'rr-failure');
  failure.hidden = true;
  failure.setAttribute('role', 'alert');
  failure.setAttribute('aria-live', 'assertive');

  const planTitle = make('h2', 'rr-tag');
  planTitle.id = 'rr-plan-title';
  planTitle.textContent = UI_TEXT.planTitle;
  // The key comes last in the scrolling part, right above the note, and is
  // scrolled to when it appears.
  const planBody = make('div', 'rr-board-body');
  // A tab stop of its own, so the keyboard can scroll it: the picker inside is
  // focusable, and a browser then does not make the scrolling part one, which
  // leaves the switches and the forbidden words under the picker out of reach.
  planBody.tabIndex = 0;
  planBody.setAttribute('role', 'region');
  planBody.setAttribute('aria-label', UI_TEXT.planBodyLabel);
  planBody.append(planTitle, levelField, switchesBlock, taboo, keyField);
  // The note, the button and the failure stay under the scrolling part, so the
  // note the puzzle is about and the one thing to press are never scrolled out
  // of reach, however many switches the level lists.
  const planFoot = make('div', 'rr-plan-foot');
  planFoot.append(sentenceField, sendButton, failure);
  const planBoard = make('section', 'rr-board rr-plan-board');
  planBoard.setAttribute('aria-labelledby', planTitle.id);
  planBoard.append(planBody, planFoot);

  // --- The track: the crate, the board, what Jev read -------------------------------

  const trackTitle = make('h2', 'rr-track-title');
  trackTitle.id = 'rr-track-title';
  trackTitle.textContent = UI_TEXT.trackTitleEmpty;

  const tools = make('div', 'rr-tools');
  tools.setAttribute('role', 'group');
  tools.setAttribute('aria-label', UI_TEXT.crateLabel);
  const crateButtons = new Map<PlaceableKind, HTMLButtonElement>();
  for (const kind of PLACEABLE) {
    const button = make('button', iconClass('rr-tool', `crate-${kind}`));
    button.type = 'button';
    crateButtons.set(kind, button);
    tools.append(button);
  }
  const takeBackButton = make('button', iconClass('rr-tool', 'takeback'));
  takeBackButton.type = 'button';
  takeBackButton.textContent = UI_TEXT.takeBack;
  tools.append(takeBackButton);
  const trackHead = make('div', 'rr-track-head');
  trackHead.append(trackTitle, tools);

  const grid = make('div', 'rr-grid');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', UI_TEXT.boardLabel);
  const cart = make('div', 'rr-cart');
  cart.setAttribute('aria-hidden', 'true');
  cart.hidden = true;
  grid.append(cart);
  const empty = make('p', 'rr-empty');
  empty.textContent = UI_TEXT.boardEmpty;
  const viewport = make('div', 'rr-viewport');
  viewport.append(grid, empty);

  const readings = make('div', 'rr-readings');
  /**
   * The panel before any run: the heading and a line saying what will be
   * there. Kept on screen rather than appearing with the first run, because a
   * panel that appears takes width from the board and the track would shrink
   * under the player's hand.
   */
  const readingsBefore = (): void => {
    const title = make('h2');
    title.textContent = UI_TEXT.readingsHeading;
    const note = make('p', 'rr-note');
    note.textContent = UI_TEXT.readingsBefore;
    readings.replaceChildren(title, note);
  };
  readingsBefore();

  const status = make('p', 'rr-status');
  // Both change while the focus is still on the button that started the run,
  // so neither would be announced on its own: the status politely, the failure
  // assertively, because the failure is the answer to what was just asked.
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const quota = make('p', 'rr-quota');
  const trackFoot = make('div', 'rr-track-foot');
  trackFoot.append(status, quota);

  const trackBoard = make('section', 'rr-board rr-track-board');
  trackBoard.setAttribute('aria-labelledby', trackTitle.id);
  // What Jev read stands beside the board when there is room, so a run never
  // shrinks the track it is about; below it when there is not.
  const trackBody = make('div', 'rr-track-body');
  trackBody.append(viewport, readings);
  trackBoard.append(trackHead, trackBody, trackFoot);

  const layout = make('main', 'rr-layout');
  layout.append(planBoard, trackBoard);
  app.append(hall, layout);
  root.replaceChildren(style, app);

  // --- State ------------------------------------------------------------------------

  let levels: readonly PublicLevel[] = [];
  let game: Game | undefined;
  let stars: Stars = readStars(services.storage);
  let tool: Tool = 'turn';
  /** Whether a run is in the air, or its cart still rolling. Every control waits on it. */
  let busy = false;
  /** The square the board's keyboard focus sits on. */
  let focusAt = { x: 0, y: 0 };
  const cells = new Map<string, HTMLButtonElement>();

  // --- Showing things -----------------------------------------------------------------

  /**
   * Shows `value`, or takes the failure off the screen.
   *
   * Revealed before it is filled, deliberately: a region filled while hidden is
   * out of the accessibility tree at the moment it changes, and the alert it
   * exists to make is never made. Cleared the other way round, hidden first.
   */
  const showFailure = (value: Failure | undefined): void => {
    if (value === undefined) {
      failure.hidden = true;
      failure.replaceChildren();
      return;
    }
    const title = make('p');
    title.textContent = value.title;
    const children: HTMLElement[] = [title];
    if (value.detail !== undefined && value.detail !== '') {
      const detail = make('p', 'rr-detail');
      detail.textContent = value.detail;
      children.push(detail);
    }
    failure.hidden = false;
    failure.replaceChildren(...children);
  };

  /** How the page scrolls something into view: at once when the person asked for stillness. */
  const scrollBehavior = (): ScrollBehavior => (services.reducedMotion() ? 'auto' : 'smooth');

  /** Writes the status line, only when the sentence changes: a live region announces every write. */
  const say = (sentence_: string): void => {
    if (status.textContent !== sentence_) status.textContent = sentence_;
  };

  const refreshControls = (): void => {
    const ready = game !== undefined && !busy;
    sendButton.disabled = !ready;
    sendButton.textContent = busy ? UI_TEXT.sending : UI_TEXT.send;
    levelPicker.disabled = busy || levels.length === 0;
    trackBoard.setAttribute('aria-busy', String(busy));
    const left = game === undefined ? undefined : stock(game);
    for (const [kind, button] of crateButtons) {
      const count = left?.[kind] ?? 0;
      button.textContent = crateLabel(kind, count);
      button.disabled = !ready || count <= 0;
      button.setAttribute('aria-pressed', String(tool === kind));
    }
    takeBackButton.disabled = !ready || game === undefined || piecesLaid(game) === 0;
    takeBackButton.setAttribute('aria-pressed', String(tool === 'takeback'));
    grid.setAttribute('data-tool', tool === 'turn' ? 'turn' : tool === 'takeback' ? 'takeback' : 'place');
  };

  const refreshNote = (): void => {
    if (game === undefined) {
      counter.textContent = '';
      warning.textContent = '';
      return;
    }
    const count = countWords(sentence.value);
    const max = game.level.max_words;
    counter.textContent = wordCount(count, max);
    counter.setAttribute('data-over', String(count > max));
    warning.textContent = noteWarning(count, max, tabooHits(game.level, sentence.value));
  };

  const letterOf = (switchId: string): string => {
    const index = game?.level.switches.findIndex((s) => s.id === switchId) ?? -1;
    return index < 0 ? '?' : switchLetter(index);
  };

  /** Redraws one square from the game. */
  const paintSquare = (x: number, y: number): void => {
    const cell = cells.get(`${String(x)},${String(y)}`);
    if (game === undefined || cell === undefined) return;
    const square = squareAt(game, x, y);
    const letter = square.kind === 'switch' ? letterOf(square.switch.id) : undefined;
    cell.setAttribute('aria-label', describeSquare(square, x, y, letter));
    cell.setAttribute('data-kind', square.kind === 'piece' ? square.piece : square.kind);
    // An empty square is not fixed: a piece from the crate can go there.
    if (square.kind === 'empty') cell.removeAttribute('data-mode');
    else cell.setAttribute('data-mode', square.kind === 'piece' ? square.mode : 'fixed');
    const piece = make('span', 'rr-piece');
    piece.setAttribute('aria-hidden', 'true');
    piece.setAttribute('style', squareArt(square));
    piece.textContent = squareGlyph(square);
    const parts: HTMLElement[] = [piece];
    if (letter !== undefined) {
      const badge = make('span', 'rr-badge');
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = letter;
      parts.push(badge);
    }
    cell.replaceChildren(...parts);
  };

  /** Takes the last run's cart and trail off the board. */
  const clearRun = (): void => {
    cart.hidden = true;
    cart.removeAttribute('data-end');
    for (const cell of cells.values()) cell.removeAttribute('data-trail');
  };

  /** Makes square (x, y) the board's one tab stop, and answers it. */
  const rove = (x: number, y: number): HTMLButtonElement | undefined => {
    const before = cells.get(`${String(focusAt.x)},${String(focusAt.y)}`);
    const after = cells.get(`${String(x)},${String(y)}`);
    if (after === undefined) return undefined;
    if (before !== undefined) before.tabIndex = -1;
    after.tabIndex = 0;
    focusAt = { x, y };
    return after;
  };

  const focusCell = (x: number, y: number): void => {
    rove(x, y)?.focus();
  };

  /** Applies an edit the player made on the board, or leaves the board as it was. */
  const apply = (edit: Edit, x: number, y: number): boolean => {
    if (!edit.ok) return false;
    game = edit.game;
    clearRun();
    paintSquare(x, y);
    // A crate that runs out puts the hand back to turning, and so does a
    // crate taken back empty.
    if (tool !== 'turn' && tool !== 'takeback' && stock(game)[tool] <= 0) tool = 'turn';
    if (tool === 'takeback' && piecesLaid(game) === 0) tool = 'turn';
    refreshControls();
    return true;
  };

  /** What a click, a tap or Enter on a square does with the tool in hand. */
  const useSquare = (x: number, y: number): void => {
    if (busy || game === undefined) return;
    const square = squareAt(game, x, y);
    if (tool === 'takeback') {
      apply(takeBack(game, x, y), x, y);
      return;
    }
    if (tool !== 'turn' && square.kind === 'empty') {
      apply(place(game, x, y, tool), x, y);
      return;
    }
    apply(turn(game, x, y), x, y);
  };

  const buildBoard = (level: PublicLevel): void => {
    cells.clear();
    const squares: HTMLButtonElement[] = [];
    for (let y = 0; y < level.height; y++) {
      for (let x = 0; x < level.width; x++) {
        const cell = make('button', 'rr-cell');
        cell.type = 'button';
        cell.tabIndex = x === 0 && y === 0 ? 0 : -1;
        cell.setAttribute('data-x', String(x));
        cell.setAttribute('data-y', String(y));
        cell.addEventListener('click', () => {
          rove(x, y);
          useSquare(x, y);
        });
        cell.addEventListener('keydown', (event: KeyboardEvent) => {
          const moves: Readonly<Record<string, readonly [number, number]>> = {
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
          };
          const move = moves[event.key];
          if (move !== undefined) {
            event.preventDefault();
            const nx = Math.min(level.width - 1, Math.max(0, x + move[0]));
            const ny = Math.min(level.height - 1, Math.max(0, y + move[1]));
            focusCell(nx, ny);
          } else if ((event.key === 'Delete' || event.key === 'Backspace') && game !== undefined && !busy) {
            event.preventDefault();
            apply(takeBack(game, x, y), x, y);
          }
        });
        cells.set(`${String(x)},${String(y)}`, cell);
        squares.push(cell);
      }
    }
    focusAt = { x: 0, y: 0 };
    grid.setAttribute('style', `--w: ${String(level.width)}; --h: ${String(level.height)}`);
    grid.replaceChildren(...squares, cart);
    for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) paintSquare(x, y);
  };

  const buildSwitches = (level: PublicLevel): void => {
    switchesBlock.hidden = false;
    if (level.switches.length === 0) {
      const none = make('li', 'rr-note');
      none.textContent = UI_TEXT.noSwitches;
      switchesList.replaceChildren(none);
      return;
    }
    switchesList.replaceChildren(
      ...level.switches.map((sw, index) => {
        const item = make('li', iconClass('rr-switch', `device-${sw.question.type}`));
        const title = make('p', 'rr-switch-title');
        title.textContent = `${switchLetter(index)} · ${switchKind(sw)}: ${sw.question.instructions}`;
        const exits = make('ul', 'rr-exits');
        exits.append(
          ...exitLines(sw).map((line) => {
            const exit = make('li');
            const answer = make('strong');
            answer.textContent = line.answer;
            const meaning = make('span');
            meaning.textContent = ` — ${line.meaning} `;
            const side = make('span', 'rr-exit-side');
            side.textContent = line.side;
            exit.append(answer, meaning, side);
            return exit;
          }),
        );
        item.append(title, exits);
        return item;
      }),
    );
  };

  const refreshPicker = (): void => {
    for (const [index, option] of [...levelPicker.children].entries()) {
      const level = levels[index];
      if (level !== undefined) option.textContent = levelOption(level.order, level.name, stars[level.id] ?? 0);
    }
  };

  const chooseLevel = (level: PublicLevel): void => {
    game = newGame(level);
    tool = 'turn';
    levelPicker.value = level.id;
    trackTitle.textContent = level.name;
    levelNote.textContent = levelRules(level.max_words, level.par_pieces);
    taboo.textContent = tabooLine(level.taboo);
    empty.hidden = true;
    // The last run belongs to the board it ran on: its cart, trail, readings
    // and failure do not come along to a new level.
    clearRun();
    buildBoard(level);
    buildSwitches(level);
    readingsBefore();
    showFailure(undefined);
    refreshNote();
    refreshControls();
    say(UI_TEXT.ready);
  };

  // --- The run ------------------------------------------------------------------------

  /** Moves the cart onto square (x, y) of the board. */
  const putCart = (x: number, y: number): void => {
    cart.setAttribute('style', `--cx: ${String(x)}; --cy: ${String(y)}`);
    cells.get(`${String(x)},${String(y)}`)?.setAttribute('data-trail', '');
  };

  /**
   * Rolls the cart along the path the backend sent, a square every frame.
   *
   * With reduced motion it does not roll: the trail is laid at once and the
   * cart is put where it stopped, so the ending is the same and nothing moves.
   */
  const roll = async (result: RunResponse): Promise<void> => {
    clearRun();
    const path = result.path;
    if (path.length === 0) return;
    cart.hidden = false;
    if (services.reducedMotion()) {
      for (const step of path) putCart(step.x, step.y);
    } else {
      cart.setAttribute('data-moving', '');
      for (const step of path) {
        putCart(step.x, step.y);
        await services.wait(FRAME_MS);
      }
      cart.removeAttribute('data-moving');
    }
    cart.setAttribute('data-end', result.outcome);
  };

  const showReadings = (result: RunResponse): void => {
    const level = game?.level;
    const title = make('h2');
    title.textContent = UI_TEXT.readingsHeading;
    const earned = make('p', 'rr-stars');
    earned.setAttribute('aria-label', starWords(result.stars));
    earned.textContent = starMarks(result.stars);
    const parts: HTMLElement[] = [title, earned];
    if (result.readings.length === 0) {
      const none = make('p', 'rr-note');
      none.textContent = UI_TEXT.noReadings;
      parts.push(none);
    } else {
      const list = make('ul');
      list.append(
        ...result.readings.map((reading) => {
          const sw = level?.switches.find((s) => s.id === reading.switch_id);
          const line = describeReading(reading, sw, letterOf(reading.switch_id));
          const item = make('li');
          item.setAttribute('data-clean', String(reading.clean));
          const heading_ = make('p', 'rr-reading-title');
          heading_.textContent = line.heading;
          const verdict = make('p', 'rr-verdict');
          verdict.textContent = `${line.verdict} ${line.margin}`;
          item.append(heading_, verdict);
          return item;
        }),
      );
      parts.push(list);
    }
    if (level !== undefined) {
      const rule = make('p', 'rr-note');
      rule.textContent = UI_TEXT.starsRule(level.par_pieces);
      parts.push(rule);
    }
    readings.replaceChildren(...parts);
  };

  const send = async (): Promise<void> => {
    if (busy || game === undefined) return;
    const playing = game;
    showFailure(undefined);
    // A note with no word in it, blanks, punctuation or invisible characters
    // alone, is the backend's `empty_sentence`: refused here, spending nothing.
    if (countWords(sentence.value) === 0) {
      showFailure({ title: UI_TEXT.emptySentence });
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = keyField.hidden ? '' : keyInput.value.trim();
    // A character no key has, pasted along with it, would make the request
    // itself fail, and the page would blame the connection.
    if (key !== '' && !/^[\x21-\x7e]+$/.test(key)) {
      showFailure({ title: UI_TEXT.keyInvalid });
      return;
    }
    if (key !== '') headers['x-typesafe-key'] = key;

    busy = true;
    refreshControls();
    say(UI_TEXT.rolling);
    try {
      let response: Response;
      try {
        response = await services.fetch('/api/run', {
          method: 'POST',
          headers,
          body: JSON.stringify(runRequest(playing, sentence.value)),
        });
      } catch {
        say('');
        showFailure({ title: UI_TEXT.networkFailed });
        return;
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (response.status !== 200 || !isRunResponse(body)) {
        say('');
        showFailure(response.status === 200 ? { title: UI_TEXT.unexpected } : describeRunError(response.status, body));
        if (response.status === 429) {
          // The free runs are spent: the count from the last run is out of date.
          quota.textContent = describeQuota(false, { remaining: 0, byok: false });
          keyField.hidden = false;
          keyField.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
        }
        return;
      }
      readingsBefore();
      say(UI_TEXT.onTrack);
      // On a narrow screen the board is above the button, out of sight once
      // the note is written: brought into view so the run is seen. Where it is
      // already in view, as on a desktop, nothing moves.
      viewport.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
      await roll(body);
      stars = recordStars(services.storage, playing.level.id, body.stars, stars);
      refreshPicker();
      showReadings(body);
      quota.textContent = describeQuota(body.cached === true, body.quota);
      say(`${describeOutcome(body.outcome)} ${starWords(body.stars)}.`);
    } finally {
      busy = false;
      refreshControls();
    }
  };

  // --- Loading -------------------------------------------------------------------------

  const loadLevels = async (): Promise<void> => {
    say(UI_TEXT.loadingLevels);
    let loaded: unknown;
    try {
      const response = await services.fetch('/api/levels');
      if (!response.ok) throw new TypeError(`levels answered ${String(response.status)}`);
      loaded = await response.json();
    } catch {
      loaded = undefined;
    }
    if (!Array.isArray(loaded) || loaded.length === 0) {
      say('');
      showFailure({ title: UI_TEXT.levelsFailed });
      return;
    }
    levels = [...(loaded as PublicLevel[])].sort((a, b) => a.order - b.order);
    levelPicker.replaceChildren(
      ...levels.map((level) => {
        const option = make('option');
        option.value = level.id;
        return option;
      }),
    );
    refreshPicker();
    // The first level not yet finished, so a return visit picks up where it left off.
    const first = levels.find((level) => stars[level.id] === undefined) ?? levels[0];
    if (first !== undefined) chooseLevel(first);
  };

  // --- Wiring ----------------------------------------------------------------------------

  /**
   * Nothing may escape a handler: a rejection left floating is logged by the
   * browser with whatever it carries. This is the net under every one of them.
   */
  const guarded = (work: () => Promise<void>) => (): void => {
    work().catch(() => {
      busy = false;
      refreshControls();
      showFailure({ title: UI_TEXT.unexpected });
    });
  };

  const pick = (chosen: Tool): void => {
    tool = tool === chosen ? 'turn' : chosen;
    refreshControls();
  };
  for (const [kind, button] of crateButtons) button.addEventListener('click', () => pick(kind));
  takeBackButton.addEventListener('click', () => pick('takeback'));
  sendButton.addEventListener('click', guarded(send));
  sentence.addEventListener('input', refreshNote);
  levelPicker.addEventListener('change', () => {
    const chosen = levels.find((level) => level.id === levelPicker.value);
    if (chosen !== undefined && !busy) chooseLevel(chosen);
  });

  refreshControls();
  guarded(loadLevels)();
}
