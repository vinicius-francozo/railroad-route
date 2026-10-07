/**
 * Dresses the page: the art the stylesheet asks for, then the mine gallery
 * around the game — a beam overhead, lanterns either side of the plaque, ore in
 * the walls, a railed floor with a rat running across it.
 *
 * The art comes first and on its own. Every track piece, switch and icon goes
 * onto the root element as a `--rr-art-*` custom property holding a data URL,
 * which the stylesheet reads with a fallback; once it is there, `data-art` on
 * the root tells the stylesheet to hide the plain characters the board shows
 * without it.
 *
 * Everything after that is scenery. It is all `aria-hidden`, none of it takes
 * a click, and nothing in the page reads it back. And all of it may give up:
 * if there is no window (the tests run in Node), the page is not the shape this
 * expects, or the browser will not draw, it returns and the page stays plain
 * and whole — `mountApp` finished the game before this started.
 */

import { beamTile, chain, drawIcons, drawSprites, drawTrackArt, floorTile, stoneTile } from './art';
import type { Sprite } from './art';
import { FRAME_MS } from './style';

type Animated = { canvas: HTMLCanvasElement; frames: readonly Sprite[]; phase: number };

type Placement = {
  /** Draw at this many screen pixels per sprite pixel. Omitted: the stylesheet sizes it. */
  scale?: number;
  /** Which frame an animated sprite starts on, so two lanterns do not flicker in step. */
  phase?: number;
  /** Inline positioning, for the pieces that each stand in a place of their own. */
  style?: Readonly<Record<string, string>>;
};

export function dressScene(root: HTMLElement): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  const doc = root.ownerDocument;
  try {
    const art = (name: string, picture: Sprite): void => {
      doc.documentElement.style.setProperty(`--rr-art-${name}`, `url(${picture.toDataURL()})`);
    };
    for (const [name, sprite] of Object.entries(drawTrackArt())) art(name, sprite);
    for (const [name, icon] of Object.entries(drawIcons())) art(name, icon);
    art('stone', stoneTile());
    art('floor', floorTile());
    art('beam', beamTile());
    doc.documentElement.setAttribute('data-art', '');
  } catch {
    // Art that could not be drawn is art left out: the board still shows a
    // character for every piece, and the game plays the same.
    return;
  }

  const app = root.querySelector<HTMLElement>('.rr-app');
  const hall = root.querySelector<HTMLElement>('.rr-hall');
  const plaque = root.querySelector<HTMLElement>('.rr-plaque');
  const boards = [...root.querySelectorAll<HTMLElement>('.rr-board')];
  if (app === null || hall === null || plaque === null || boards.length === 0) {
    return;
  }
  try {
    build(root, { app, hall, plaque, boards });
  } catch {
    // Scenery that could not be drawn is scenery left out.
  }
}

function build(
  root: HTMLElement,
  at: { app: HTMLElement; hall: HTMLElement; plaque: HTMLElement; boards: readonly HTMLElement[] },
): void {
  const doc = root.ownerDocument;
  const sprites = drawSprites();
  const animated: Animated[] = [];

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    style: Readonly<Record<string, string>> = {},
  ): HTMLElementTagNameMap[K] => {
    const made = doc.createElement(tag);
    made.className = className;
    made.setAttribute('aria-hidden', 'true');
    for (const [property, value] of Object.entries(style)) made.style.setProperty(property, value);
    return made;
  };

  const put = (frames: readonly Sprite[] | undefined, className: string, how: Placement = {}): HTMLCanvasElement => {
    const canvas = element('canvas', `rr-px ${className}`, how.style);
    const first = frames?.[0];
    if (frames === undefined || first === undefined) return canvas;
    canvas.width = first.width;
    canvas.height = first.height;
    if (how.scale !== undefined) {
      canvas.style.width = `${String(first.width * how.scale)}px`;
      canvas.style.height = `${String(first.height * how.scale)}px`;
    }
    canvas.getContext('2d')?.drawImage(first, 0, 0);
    if (frames.length > 1) animated.push({ canvas, frames, phase: how.phase ?? 0 });
    return canvas;
  };
  const sprite = (name: string, className: string, how?: Placement): HTMLCanvasElement =>
    put(sprites[name], className, how);

  const standing = (child: HTMLElement): HTMLSpanElement => {
    const span = element('span', 'rr-standing');
    span.append(child);
    return span;
  };

  // --- Overhead: the beam, the plaque's chains, two lanterns -------------------

  const beam = element('div', 'rr-beam');
  beam.append(
    sprite('bracket', 'rr-bracket', { scale: 3, style: { left: '16%' } }),
    sprite('bracket', 'rr-bracket', { scale: 3, style: { right: '16%' } }),
  );
  at.app.prepend(beam);

  const lantern = (side: 'l' | 'r', phase: number): HTMLElement => {
    const wrap = element('div', `rr-lantern-wrap ${side}`);
    wrap.append(put([chain(5)], 'rr-chain rr-soft-shadow'), sprite('lantern', 'rr-lamp rr-wall-shadow', { phase }));
    return wrap;
  };
  // Before and after the plaque: the hall is a grid, and an item placed in an
  // earlier column than the one before it would start a new row.
  at.plaque.before(lantern('l', 0));
  at.plaque.after(lantern('r', 1));
  at.plaque.prepend(
    put([chain(3)], 'rr-chain rr-plaque-chain rr-soft-shadow', { scale: 3, style: { left: '28px' } }),
    put([chain(3)], 'rr-chain rr-plaque-chain rr-soft-shadow', { scale: 3, style: { right: '28px' } }),
  );

  at.hall.prepend(
    sprite('vein', 'rr-prop rr-vein', { style: { left: '4%', top: '24%' } }),
    sprite('vein2', 'rr-prop rr-vein', { style: { right: '6%', top: '58%' } }),
    sprite('crack', 'rr-prop rr-crack', { style: { left: '21%', top: '50%' } }),
    sprite('crack2', 'rr-prop rr-crack', { style: { right: '22%', top: '16%' } }),
    sprite('moss', 'rr-prop rr-moss', { style: { left: '1%', bottom: '6%' } }),
    sprite('moss', 'rr-prop rr-moss', { style: { right: '12%', bottom: '10%' } }),
  );

  // --- The walls to either side, on a wide enough screen ------------------------

  const floorRow = (...items: HTMLElement[]): HTMLElement => {
    const row = element('div', 'rr-floor-row');
    row.append(...items);
    return row;
  };
  const left = element('aside', 'rr-side l');
  left.append(
    sprite('tools', 'rr-wall-shadow', { scale: 4 }),
    sprite('vein', 'rr-soft-shadow', { scale: 3 }),
    element('i', 'rr-grow'),
    floorRow(standing(sprite('crates', '', { scale: 2 })), standing(sprite('barrel', '', { scale: 3 }))),
  );
  const right = element('aside', 'rr-side r');
  right.append(
    sprite('vein2', 'rr-soft-shadow', { scale: 3 }),
    element('i', 'rr-grow'),
    floorRow(standing(sprite('cart', '', { scale: 5 })), standing(sprite('sack', '', { scale: 2 }))),
  );
  at.app.prepend(left, right);

  // --- The boards: a rivet in each corner ---------------------------------------

  for (const board of at.boards) {
    for (const corner of ['tl', 'tr', 'bl', 'br']) board.append(element('i', `rr-rivet ${corner}`));
  }

  // --- Underfoot ----------------------------------------------------------------

  const critters = element('div', 'rr-critters');
  critters.append(sprite('rat', 'rr-rat'));
  root.append(element('div', 'rr-floor'), critters);

  // --- And then it moves, unless the person asked for stillness ------------------

  const still = doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? true;
  if (still || animated.length === 0) {
    return;
  }
  let tick = 0;
  doc.defaultView?.setInterval(() => {
    tick += 1;
    for (const { canvas, frames, phase } of animated) {
      const frame = frames[(tick + phase) % frames.length];
      const context = canvas.getContext('2d');
      if (frame === undefined || context === null) continue;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(frame, 0, 0);
    }
  }, FRAME_MS);
}
