/**
 * Every sprite, icon and texture on the page, drawn pixel by pixel in code.
 *
 * The kit — the palette, `fromRows`, `maskIcon` and the seeded `rng` — comes
 * from Gridsmith's `src/ui/art.ts`, unchanged. A sprite is either a grid of
 * palette letters (`fromRows`), a shape tested per pixel (`maskIcon`) or a few
 * rectangles in a function, so each piece stays editable as text and the page
 * downloads no image at all.
 *
 * Browser only: every drawing function here creates a `<canvas>` through
 * `document`. `scene.ts` is the one caller, and it checks for a document
 * before it calls. The few plain values exported beside them — which exit
 * marks exist (`ORE_NAMES`, `METER_MAX`, `PIP_COUNT`, `exitMarkNames`) — draw
 * nothing, so `messages.ts` reads them anywhere, the tests' Node included.
 */

/** A drawn sprite, at one pixel per pixel. The page scales it with CSS. */
export type Sprite = HTMLCanvasElement;

/** Paints a rectangle in a palette letter, or in any CSS colour. */
export type Pen = (x: number, y: number, w: number, h: number, colour: string) => void;

/** A seeded source of numbers in [0, 1), so a sprite comes out the same every load. */
export type Rng = () => number;

/** The shared palette. Most sprites name colours by one of these letters. */
export const PAL: Readonly<Record<string, string>> = {
  k: '#1a1410', n: '#2b1c12', w: '#5a3820', W: '#7a4d2b', h: '#9c6a3c',
  g: '#d9a441', G: '#f2cf72', o: '#8a6424',
  s: '#6d717a', S: '#9aa0a8', d: '#43464d', x: '#121012',
  r: '#9b2b2b', R: '#c9473a', e: '#b8431f', f: '#f08a2c', F: '#ffd35c', y: '#fff2b3',
  m: '#2f5d33', M: '#4c8a43', c: '#e2dccb', C: '#a59f8e', p: '#e8d6a8', P: '#bfa877',
  i: '#50545c', I: '#8a909a',
  v: '#57496a', V: '#7d6c94', b: '#0e1a2e', B: '#1c2f4d', q: '#dfe8f2',
  // This page's own: coal, crystal, and the earth the mine is cut into.
  a: '#55525e', A: '#a9a6b4', Q: '#36343c', j: '#3fb6d0', J: '#bff2fb', l: '#1f6f8f',
  z: '#4a3a2c', Z: '#66523f',
};

/** Mulberry32. Decoration only: nothing in the game reads it. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

export function context(cv: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = cv.getContext('2d');
  if (ctx === null) {
    throw new TypeError('the browser gave no 2d context for a sprite');
  }
  return ctx;
}

export function pen(ctx: CanvasRenderingContext2D): Pen {
  return (x, y, w, h, colour) => {
    ctx.fillStyle = PAL[colour] ?? colour;
    ctx.fillRect(x, y, w, h);
  };
}

/** A sprite drawn from rows of palette letters; `.` is transparent. */
export function fromRows(rows: readonly string[], palette: Readonly<Record<string, string>> = PAL): Sprite {
  const w = Math.max(...rows.map((row) => row.length));
  const cv = canvas(w, rows.length);
  const ctx = context(cv);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const colour = palette[ch] ?? PAL[ch];
      if (ch !== '.' && colour !== undefined) {
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
      }
    });
  });
  return cv;
}

/**
 * A shape given as a test per pixel, outlined where it meets the background.
 *
 * `solid` may cover more than is painted: a key's hole counts as solid so that
 * its rim is not outlined, which is what keeps a 12-pixel ring from coming out
 * as solid black.
 */
export function maskIcon(
  w: number,
  h: number,
  solid: (x: number, y: number) => boolean,
  paint: (x: number, y: number) => string,
): Sprite {
  const cv = canvas(w, h);
  const P = pen(context(cv));
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && solid(x, y);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      P(x, y, 1, 1, edge ? 'k' : paint(x, y));
    }
  }
  return cv;
}

// --- The track ----------------------------------------------------------------
//
// Every piece of track is 16 × 16 and drawn per pixel from its geometry, the
// way `maskIcon` draws a shape: each rail and each sleeper is a band around a
// centre line, and a pixel inside a band takes the light tone on the side that
// faces the top-left and the dark tone on the other, with a hard shadow one
// pixel further out on the dark side. The light is worked out on the screen,
// after the piece is turned, so a turned piece is still lit from the top left —
// turning a finished sprite with CSS would put the shadow on the wrong side
// three times out of four.

/** A side of a cell, as the contract names them: north is up. */
export type Side = 'N' | 'E' | 'S' | 'W';

const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const STEP: Readonly<Record<Side, readonly [number, number]>> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** `side` turned clockwise by `quarters` quarter turns. */
export function turnSide(side: Side, quarters: number): Side {
  return SIDES[(SIDES.indexOf(side) + quarters) % 4] ?? side;
}

/** Where a pixel sits against a band: how far from its centre line, and which way is "further". */
type Reading = { d: number; nx: number; ny: number };
type Band = (x: number, y: number) => Reading | undefined;
type Tones = { light: string; dark: string; half: number };

const RAIL: Tones = { light: 'S', dark: 'i', half: 1 };
const SLEEPER: Tones = { light: 'h', dark: 'w', half: 1 };
/** A sleeper across a bend is thinner: on the diagonal a band of 1 is three pixels thick. */
const BENT_SLEEPER: Tones = { light: 'h', dark: 'w', half: 0.75 };
const BUFFER: Tones = { light: 'R', dark: 'r', half: 1.5 };

/**
 * The rails of the branches of a switch the cart did not take, after a run:
 * the same rails in the tones of the ground, so the one it took is the only
 * bright way out.
 */
const DIM_RAIL: Tones = { light: '#5a5048', dark: '#3a332c', half: 1 };

/** Paints `bands` in `tones`: their shadows first, then the bands over them. */
function paintBands(P: Pen, bands: readonly Band[], tones: Tones): void {
  for (const pass of ['shadow', 'body'] as const) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        for (const band of bands) {
          const at = band(x + 0.5, y + 0.5);
          if (at === undefined) continue;
          const sign = at.d < 0 ? -1 : 1;
          // Facing the light is facing up and to the left: (-1, -1).
          const lit = -(sign * at.nx + sign * at.ny) >= 0;
          const off = Math.abs(at.d);
          if (pass === 'body' && off < tones.half) {
            P(x, y, 1, 1, lit ? tones.light : tones.dark);
          } else if (pass === 'shadow' && !lit && off >= tones.half && off < tones.half + 1) {
            P(x, y, 1, 1, 'k');
          }
        }
      }
    }
  }
}

/** A straight run between two opposite sides, or from one side part of the way in. */
type Run = { axis: 'NS' | 'EW'; from: number; to: number };
/** A quarter circle between two neighbouring sides, around the corner they share. */
type Arc = { cx: number; cy: number };

/** The run from `side` toward the middle, `reach` pixels long. */
function stub(side: Side, reach: number): Run {
  const axis = side === 'N' || side === 'S' ? 'NS' : 'EW';
  return side === 'N' || side === 'W' ? { axis, from: 0, to: reach } : { axis, from: 16 - reach, to: 16 };
}

function arcBetween(a: Side, b: Side): Arc {
  const [ax, ay] = STEP[a];
  const [bx, by] = STEP[b];
  return { cx: 8 + 8 * (ax + bx), cy: 8 + 8 * (ay + by) };
}

/** Rails sit five pixels in from each edge, so every piece meets its neighbour. */
const GAUGE = [5, 11] as const;

function runRails(run: Run): Band[] {
  return GAUGE.map((centre): Band => (x, y) => {
    const along = run.axis === 'NS' ? y : x;
    if (along < run.from || along >= run.to) return undefined;
    return run.axis === 'NS' ? { d: x - centre, nx: 1, ny: 0 } : { d: y - centre, nx: 0, ny: 1 };
  });
}

function runSleepers(run: Run): Band[] {
  return [2, 6, 10, 14]
    .filter((centre) => centre > run.from && centre < run.to)
    .map((centre): Band => (x, y) => {
      const across = run.axis === 'NS' ? x : y;
      if (Math.abs(across - 8) >= 6) return undefined;
      return run.axis === 'NS' ? { d: y - centre, nx: 0, ny: 1 } : { d: x - centre, nx: 1, ny: 0 };
    });
}

function arcRails(arc: Arc): Band[] {
  // The inner rail is 5 from the corner and the outer 11, which lands both on
  // the gauge where they cross the edge.
  return [5, 11].map((radius): Band => (x, y) => {
    const r = Math.hypot(x - arc.cx, y - arc.cy);
    return r === 0 ? undefined : { d: r - radius, nx: (x - arc.cx) / r, ny: (y - arc.cy) / r };
  });
}

function arcSleepers(arc: Arc): Band[] {
  const middle = Math.atan2(8 - arc.cy, 8 - arc.cx);
  // Three sleepers, a third of the quarter apart: four, at sixteen pixels,
  // ran into each other on the inside of the bend.
  return [-0.52, 0, 0.52].map((offset): Band => {
    const angle = middle + offset;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    return (x, y) => {
      const dx = x - arc.cx;
      const dy = y - arc.cy;
      const r = Math.hypot(dx, dy);
      if (r < 3 || r > 13 || dx * ux + dy * uy <= 0) return undefined;
      return { d: dx * -uy + dy * ux, nx: -uy, ny: ux };
    };
  });
}

/** Draws runs and arcs as one piece of track: every sleeper first, then every rail. */
function track(P: Pen, runs: readonly Run[], arcs: readonly Arc[]): void {
  paintBands(P, runs.flatMap(runSleepers), SLEEPER);
  paintBands(P, arcs.flatMap(arcSleepers), BENT_SLEEPER);
  paintBands(P, [...runs.flatMap(runRails), ...arcs.flatMap(arcRails)], RAIL);
}

function tile(draw: (P: Pen) => void): Sprite {
  const cv = canvas(16, 16);
  draw(pen(context(cv)));
  return cv;
}

/** The track a piece lays from `entry` to each of `exits`: straight across, or curving. */
function laid(entry: Side, exits: readonly Side[]): { runs: Run[]; arcs: Arc[] } {
  const runs: Run[] = [];
  const arcs: Arc[] = [];
  for (const exit of exits) {
    if (turnSide(entry, 2) === exit) {
      runs.push({ axis: entry === 'N' || entry === 'S' ? 'NS' : 'EW', from: 0, to: 16 });
    } else {
      arcs.push(arcBetween(entry, exit));
    }
  }
  return { runs, arcs };
}

function straightTile(rotation: number): Sprite {
  return tile((P) => {
    const { runs } = laid(turnSide('N', rotation), [turnSide('S', rotation)]);
    track(P, runs, []);
  });
}

function curveTile(rotation: number): Sprite {
  return tile((P) => {
    track(P, [], [arcBetween(turnSide('N', rotation), turnSide('E', rotation))]);
  });
}

function crossTile(rotation: number): Sprite {
  // Turned, a cross is the same two runs; the one laid second is on top, so a
  // turn swaps which line looks like it passes over.
  const order: Run[] = [
    { axis: 'NS', from: 0, to: 16 },
    { axis: 'EW', from: 0, to: 16 },
  ];
  if (rotation % 2 === 1) order.reverse();
  return tile((P) => {
    paintBands(P, order.flatMap(runSleepers), SLEEPER);
    for (const run of order) paintBands(P, runRails(run), RAIL);
  });
}

/** Where the cart starts: a buffer stop at the closed end, and a green lamp beside it. */
function startTile(rotation: number): Sprite {
  const open = turnSide('E', rotation);
  return tile((P) => {
    const run = stub(open, 13);
    track(P, [run], []);
    const centre = open === 'N' || open === 'W' ? 12 : 4;
    paintBands(P, [
      (x, y) => {
        const across = run.axis === 'NS' ? x : y;
        if (Math.abs(across - 8) >= 6.5) return undefined;
        return run.axis === 'NS' ? { d: y - centre, nx: 0, ny: 1 } : { d: x - centre, nx: 1, ny: 0 };
      },
    ], BUFFER);
    // The lamp stands in the corner the track leaves free.
    const [ox, oy] = STEP[open];
    const lx = ox === 0 ? 1 : ox > 0 ? 1 : 12;
    const ly = oy === 0 ? 1 : oy > 0 ? 1 : 12;
    P(lx, ly, 3, 3, 'k'); P(lx + 1, ly + 1, 1, 1, '#9be08d'); P(lx + 1, ly + 2, 1, 1, 'M');
  });
}

/** The mine: a timbered mouth with gold in the dark, the track running into it. */
function mineTile(rotation: number): Sprite {
  const open = turnSide('W', rotation);
  return tile((P) => {
    track(P, [stub(open, 9)], []);
    P(2, 3, 12, 11, 'k');
    P(5, 5, 6, 8, 'x'); P(5, 10, 6, 3, '#0a0808');
    P(3, 4, 2, 9, 'W'); P(3, 4, 1, 9, 'h'); P(11, 4, 2, 9, 'W'); P(11, 4, 1, 9, 'h');
    P(2, 3, 12, 2, 'W'); P(2, 3, 12, 1, 'h'); P(2, 5, 3, 1, 'w'); P(11, 5, 3, 1, 'w');
    P(6, 11, 1, 1, 'g'); P(8, 9, 1, 1, 'G'); P(9, 12, 1, 1, 'o'); P(7, 7, 1, 1, 'o');
    // A lamp hung from the lintel.
    P(7, 0, 2, 3, 'k'); P(7, 1, 2, 1, 'F'); P(7, 2, 2, 1, 'f');
    P(3, 13, 3, 1, 'w'); P(10, 13, 3, 1, 'w');
  });
}

/** A wrong tunnel: a bare stone arch, a rust-red warning band, nothing inside. */
function tunnelTile(rotation: number): Sprite {
  const open = turnSide('W', rotation);
  return tile((P) => {
    track(P, [stub(open, 9)], []);
    for (let y = 2; y < 14; y++) {
      for (let x = 1; x < 15; x++) {
        const dx = x + 0.5 - 8;
        const dy = y + 0.5 - 8;
        const outer = dy < 0 ? Math.hypot(dx, dy) <= 6.6 : Math.abs(dx) <= 6.6 && y <= 13;
        const inner = dy < 0 ? Math.hypot(dx, dy) <= 3.6 : Math.abs(dx) <= 3.6;
        if (!outer) continue;
        const rim = dy < 0 ? Math.hypot(dx, dy) > 5.7 : Math.abs(dx) > 5.7;
        P(x, y, 1, 1, inner ? (y > 10 ? '#0a0808' : 'x') : rim ? 'k' : dx + dy < -3 ? 'S' : dx + dy > 3 ? 'd' : 's');
      }
    }
    P(3, 4, 10, 2, 'k'); P(4, 4, 2, 1, 'R'); P(8, 4, 2, 1, 'R'); P(6, 4, 2, 1, 'c'); P(10, 4, 2, 1, 'c');
    P(4, 5, 8, 1, 'r');
  });
}

/** A boulder: no track goes through it and nothing can be laid on it. */
function rockTile(): Sprite {
  const solid = (x: number, y: number): boolean => ((x + 0.5 - 8) / 6.6) ** 2 + ((y + 0.5 - 9) / 5.4) ** 2 <= 1;
  return maskIcon(16, 16, solid, (x, y) => {
    if ((x === 9 && y >= 6 && y <= 8) || (x === 10 && y === 9) || (x === 5 && y === 10)) return 'd';
    const t = (x - 8) + (y - 9);
    return t < -3 ? 'S' : t > 3 ? 'd' : 's';
  });
}

/** The dark ballast a switch's rails lie on, which every exit mark is read against. */
export const BALLAST = '#3a2b1f';

/** The gravel under every cell, the same on every load. */
function groundTile(): Sprite {
  const cv = canvas(16, 16);
  const P = pen(context(cv));
  const r = rng(29);
  P(0, 0, 16, 16, '#26221e');
  for (let i = 0; i < 26; i++) P((r() * 16) | 0, (r() * 16) | 0, 1, 1, r() < 0.5 ? '#2f2a25' : '#1d1a17');
  for (let i = 0; i < 4; i++) {
    const x = (r() * 15) | 0;
    const y = (r() * 15) | 0;
    P(x, y, 2, 1, '#3a3530'); P(x + 1, y + 1, 1, 1, '#141210');
  }
  return cv;
}

/**
 * The track under a switch: from its entry to every side it can send the cart
 * to, lit, or in the ground's tones for the branches a run did not take.
 *
 * Rails only, on a bed of dark ballast that sets the square apart: the
 * sleepers of two or three branches laid over each other in sixteen pixels are
 * a tangle, and the rails alone read as the ways out. With `bed` false it is
 * the rails alone, to lay one lit branch over a dimmed junction.
 */
function junctionTile(entry: Side, exits: readonly Side[], rail: Tones = RAIL, bed = true): Sprite {
  return tile((P) => {
    const { runs, arcs } = laid(entry, exits);
    if (bed) {
      P(0, 0, 16, 16, '#120d09');
      P(1, 1, 14, 14, BALLAST);
      P(1, 1, 14, 1, '#4d3a2a');
      P(1, 1, 1, 14, '#4d3a2a');
      P(2, 14, 13, 1, '#2a1f16');
      P(14, 2, 1, 13, '#2a1f16');
    }
    paintBands(P, [...runs.flatMap(runRails), ...arcs.flatMap(arcRails)], rail);
  });
}

// --- What a switch shows ----------------------------------------------------------
//
// A switch is its track and nothing standing on it: the branches from the entry
// to every exit, a mark at the end of each branch that says which answer leads
// there, and one badge with the switch's letter and a glyph for its kind. The
// marks are the same pictures the list of questions puts beside each answer,
// so the board and the list are read with one key.
//
// A mark is 6 × 6 with its outline, sized so that, at the end of a branch, it
// sits between the two rails and covers only their inner pixel: the track is
// still seen running to the edge on both sides of it.

/**
 * Rows for `fromRows`: an ore, as a lump on the end of a branch. Coal is a
 * black lump whose top-left edge and one facet catch the lamp light: outlined
 * in black only, as the others are, it sank into the dark ballast.
 */
export const ORE_MARKS: Readonly<Record<string, readonly string[]>> = {
  coal: ['..SIk.', '.SyIak', 'SIaQQk', 'IaQxQk', 'kQxxxk', '.kkkk.'],
  gold: ['.kkk..', 'kGGgk.', 'kGggok', 'kgggok', '.kgook', '..kkk.'],
  crystal: ['..kk..', '.kJjk.', 'kJjjlk', 'kjjjlk', '.kjlk.', '..kk..'],
};

/**
 * A yes or a no, as the lamps and signs a miner knows: a green chip with a
 * lit lamp in it, and a red "no entry" chip with a bar. Told apart by shape as
 * well as colour. (A tick and a cross were tried first: in four pixels they
 * read as a checker and a ring.)
 */
const ANSWER_MARKS: Readonly<Record<string, readonly string[]>> = {
  yes: ['kkkkkk', 'kMMMMk', 'kMccMk', 'kMccMk', 'kmmmmk', 'kkkkkk'],
  no: ['kkkkkk', 'kRRRRk', 'kcccck', 'kcccck', 'krrrrk', 'kkkkkk'],
};

/** A colour per option for a choice whose options have no picture of their own. */
const PIP_COLOURS: readonly (readonly [string, string])[] = [
  ['#6aa6ff', '#3d6fc4'],
  ['#d08ae8', '#8f4fb0'],
  ['#f2a65a', '#b86a22'],
  ['#9be08d', '#4c8a43'],
];

/** The most levels a scale's mark draws as a meter; past that, its levels get pips. */
export const METER_MAX = 4;

/**
 * The colours a meter lights its bars in, by how far up the scale its level
 * is: green at the bottom, amber, then red at the top. Digits, so they never
 * clash with a letter of `PAL`.
 */
export const METER_PAL: Readonly<Record<string, string>> = { '1': '#5fd35a', '2': '#ffc83d', '3': '#ff8a3c', '4': '#ff5a3c' };

/** Which `METER_PAL` colour each level of a scale of 2, 3 or 4 levels lights. */
const METER_COLOURS: Readonly<Record<number, readonly string[]>> = { 2: ['1', '4'], 3: ['1', '2', '4'], 4: ['1', '2', '3', '4'] };

/**
 * Level `level` of a scale of `levels`, as rows for `fromRows` with
 * `METER_PAL`: a dark chip in an iron frame with a rising staircase of bars,
 * lit up to and including that level, in that level's colour. "Calm" lights
 * the short bar green, "rush" every bar red: told apart by colour at a glance,
 * and by the count of bars without colour.
 */
export function meterRows(level: number, levels: number): string[] {
  const rows = ['IIIIIi', 'Ixxxxi', 'Ixxxxi', 'Ixxxxi', 'Ixxxxi', 'Iiiiii'].map((row) => [...row]);
  const lit = METER_COLOURS[levels]?.[level] ?? 'F';
  for (let bar = 0; bar < levels; bar++) {
    const x = 5 - levels + bar;
    const height = 4 - (levels - 1 - bar);
    for (let y = 5 - height; y < 5; y++) {
      const row = rows[y];
      if (row !== undefined) row[x] = bar <= level ? lit : 'd';
    }
  }
  return rows.map((row) => row.join(''));
}

function pipMark(index: number): Sprite {
  const [light, dark] = PIP_COLOURS[index % PIP_COLOURS.length] ?? ['#c9c9c9', '#7a7a7a'];
  return maskIcon(6, 6, (x, y) => !((x === 0 || x === 5) && (y === 0 || y === 5)), (x, y) => (x + y <= 4 ? light : dark));
}

/**
 * Every exit mark, by the name `exitMark` in `messages.ts` gives it: an ore,
 * a yes or a no, a level of a scale (`level-<level>-<levels>`), or a pip.
 */
function exitMarkSprites(): Record<string, Sprite> {
  const marks: Record<string, Sprite> = {};
  for (const [name, rows] of Object.entries({ ...ORE_MARKS, ...ANSWER_MARKS })) marks[name] = fromRows(rows);
  for (let levels = 2; levels <= METER_MAX; levels++) {
    for (let level = 0; level < levels; level++) marks[`level-${String(level)}-${String(levels)}`] = fromRows(meterRows(level, levels), METER_PAL);
  }
  PIP_COLOURS.forEach((_, index) => {
    marks[`pip-${String(index)}`] = pipMark(index);
  });
  return marks;
}

/** The names of every exit mark this module draws, without drawing them. */
export function exitMarkNames(): string[] {
  const names = [...Object.keys(ORE_MARKS), ...Object.keys(ANSWER_MARKS)];
  for (let levels = 2; levels <= METER_MAX; levels++) {
    for (let level = 0; level < levels; level++) names.push(`level-${String(level)}-${String(levels)}`);
  }
  PIP_COLOURS.forEach((_, index) => names.push(`pip-${String(index)}`));
  return names;
}

/** The names of the options an ore mark exists for. */
export const ORE_NAMES: readonly string[] = Object.keys(ORE_MARKS);

/** How many options a choice can tell apart with pips. */
export const PIP_COUNT = PIP_COLOURS.length;

/**
 * The glyph on a switch's badge, in ink on the parchment: a fork for a choice
 * between ways, a question mark for the gate's yes or no, a rising staircase
 * for the scale — the shape its meters light up. 5 × 5, no outline: the badge
 * is the outline. (A barrier arm and a balance were tried for the last two and
 * did not read at 10 pixels.)
 */
const TYPE_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  choice: ['k.k.k', 'k.k.k', '.kkk.', '..k..', '..k..'],
  noul: ['.kkk.', 'k...k', '...k.', '.....', '..k..'],
  score: ['....k', '...kk', '..kkk', '.kkkk', 'kkkkk'],
};

// --- The cart -------------------------------------------------------------------

/** The mine cart, side on, laden with ore. Two frames, side by side, for the wheels. */
function cartStrip(): Sprite {
  const cv = canvas(32, 16);
  const P = pen(context(cv));
  for (const frame of [0, 1]) {
    const o = frame * 16;
    // The load: lumps of gold above the rim.
    P(o + 3, 2, 10, 4, 'k');
    P(o + 4, 3, 3, 2, 'g'); P(o + 4, 3, 1, 1, 'G'); P(o + 8, 2, 3, 3, 'k'); P(o + 8, 3, 2, 2, 'g'); P(o + 8, 3, 1, 1, 'G');
    P(o + 11, 4, 1, 1, 'o'); P(o + 6, 4, 2, 1, 'o');
    // The tub: an iron rim, a wooden body banded in iron, narrowing to the base.
    P(o + 1, 5, 14, 2, 'k'); P(o + 2, 6, 12, 1, 'I');
    P(o + 1, 7, 14, 1, 'k'); P(o + 2, 7, 12, 1, 'W'); P(o + 2, 7, 1, 1, 'h');
    P(o + 2, 8, 12, 2, 'k'); P(o + 3, 8, 10, 1, 'i'); P(o + 3, 9, 10, 1, 'W'); P(o + 3, 9, 1, 1, 'h');
    P(o + 3, 10, 10, 2, 'k'); P(o + 4, 10, 8, 1, 'w');
    // Two wheels whose spokes turn between the frames.
    for (const wx of [3, 9]) {
      P(o + wx + 1, 11, 2, 1, 'k'); P(o + wx, 12, 4, 2, 'k'); P(o + wx + 1, 14, 2, 1, 'k');
      P(o + wx + 1, 12, 1, 1, frame === 0 ? 'S' : 'd'); P(o + wx + 2, 12, 1, 1, frame === 0 ? 'd' : 'S');
      P(o + wx + 1, 13, 1, 1, frame === 0 ? 'd' : 'S'); P(o + wx + 2, 13, 1, 1, frame === 0 ? 'S' : 'd');
    }
  }
  return cv;
}

// --- Icons ----------------------------------------------------------------------

const ICON_ROWS: Readonly<Record<string, readonly string[]>> = {
  // From Gridsmith: the scroll the sentence is written on.
  scroll: ['............', '.PPpppppppP.', '.Pppppppppk.', '..pkkkkkkp..', '..pppppppp..', '..pkkkkkkp..', '..pppppppp..', '..pkkkkp.p..', '..pppppppp..', '.Pppppppppk.', '.PPpppppppP.', '............'],
  // An arrow curling back: a laid piece goes back to the crate.
  // A pick: the iron head arched over a wooden haft.
  pickaxe: ['...kkkkkk...', '.kkSSSSIIkk.', 'kSSkkkkkkIik', 'kkk.kWk..kkk', '....kWk.....', '....khk.....', '....kWk.....', '....khk.....', '....kWk.....', '....kWk.....', '....kwk.....', '....kkk.....'],
  takeback: ['............', '....kk......', '...kGk......', '..kGGkkkkk..', '.kGGGGGGGGk.', '..kgGkkkkGgk', '...kgk...kgk', '....kk...kgk', '.........kgk', '....kkkkkgk.', '....kooook..', '....kkkkk...'],
};

function keyIcon(): Sprite {
  // From Gridsmith, unchanged.
  const ring = (x: number, y: number): boolean => Math.hypot(x + 0.5 - 3.5, y + 0.5 - 4.5) <= 3.6;
  const hole = (x: number, y: number): boolean => Math.hypot(x + 0.5 - 3.5, y + 0.5 - 4.5) <= 1.25;
  const shaft = (x: number, y: number): boolean => y >= 3 && y <= 5 && x >= 6 && x <= 11;
  const bit = (x: number, y: number): boolean =>
    x >= 8 && x <= 11 && y >= 6 && y <= 9 && !(x === 10 && y >= 7) && !(x === 11 && y === 9);
  return maskIcon(
    12,
    12,
    (x, y) => ring(x, y) || shaft(x, y) || bit(x, y),
    (x, y) => (hole(x, y) ? 'x' : y <= 3 ? 'G' : y >= 6 ? 'o' : 'g'),
  );
}

// --- The mine around the board --------------------------------------------------
//
// Scenery only, none of it read back by the game. The chain, the lantern, the
// crack, the gold seam, the tools, the sack and the rat are Gridsmith's or this
// page's from before; the earth, the timbering, the floor, the coal and the
// crystal in the rock, the dynamite, the bucket and the standing lamp are the
// mine's own.

/**
 * The earth the mine is cut into: strata of clay, ochre and gravel with wavy
 * seams, rounded pebbles lit from the top left, and one fleck of each cargo —
 * gold, coal, crystal. Tiles both ways: the waves repeat across its width, and
 * its first and last strata are one colour, so the seam between two tiles is
 * not seen.
 */
export function earthTile(): Sprite {
  const W = 96;
  const H = 64;
  const cv = canvas(W, H);
  const P = pen(context(cv));
  const r = rng(13);
  const strata: readonly (readonly [number, string])[] = [
    [0, '#2a1c12'], [9, '#3a2817'], [14, '#22170f'], [25, '#2d2016'], [35, '#33241a'], [45, '#1f150e'], [54, '#2a1c12'],
  ];
  const waves = strata.map(() => ({ phase: r() * Math.PI * 2, bends: 1 + ((r() * 2) | 0) }));
  const seamAt = (index: number, x: number): number => {
    const [top] = strata[index] ?? [0];
    const wave = waves[index] ?? { phase: 0, bends: 1 };
    return index === 0 ? 0 : top + Math.round(1.8 * Math.sin((x / W) * Math.PI * 2 * wave.bends + wave.phase));
  };
  for (let x = 0; x < W; x++) {
    for (let index = 0; index < strata.length; index++) {
      const from = seamAt(index, x);
      const to = index + 1 < strata.length ? seamAt(index + 1, x) : H;
      P(x, from, 1, to - from, strata[index]?.[1] ?? '#2a1c12');
      // The seam itself: a dark line under a lighter one, broken in places.
      if (index > 0 && index < strata.length - 1 && r() < 0.75) {
        P(x, from, 1, 1, '#150e08');
        if (r() < 0.5) P(x, from + 1, 1, 1, '#3d2b1d');
      }
    }
  }
  for (let i = 0; i < 160; i++) P((r() * W) | 0, (r() * H) | 0, 1, 1, r() < 0.5 ? '#37281c' : '#1a110a');
  // The gravel stratum: small stones packed in it.
  for (let i = 0; i < 26; i++) {
    const x = (r() * (W - 2)) | 0;
    const y = seamAt(3, x) + 2 + ((r() * 6) | 0);
    P(x, y, 2, 1, '#4d3c2d'); P(x, y + 1, 2, 1, '#1a110a');
  }
  // Pebbles: rounded, outlined, three tones.
  const pebble = (cx: number, cy: number, rx: number, ry: number): void => {
    const inside = (x: number, y: number): boolean => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
    for (let y = Math.floor(cy - ry) - 1; y <= cy + ry + 1; y++) {
      for (let x = Math.floor(cx - rx) - 1; x <= cx + rx + 1; x++) {
        if (!inside(x, y)) continue;
        const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
        const t = (x + 0.5 - cx) / rx + (y + 0.5 - cy) / ry;
        P(x, y, 1, 1, edge ? '#140d08' : t < -0.5 ? 'Z' : t > 0.5 ? '#3a2d22' : 'z');
      }
    }
  };
  for (let i = 0; i < 9; i++) {
    const rx = 1.6 + r() * 2.4;
    const ry = 1.4 + r() * 1.4;
    pebble(5 + r() * (W - 10), 4 + r() * (H - 8), rx, ry);
  }
  // One fleck of each cargo, small, in the rock.
  for (const [light, dark] of [['G', 'o'], ['A', 'a'], ['J', 'l']] as const) {
    const x = 4 + ((r() * (W - 8)) | 0);
    const y = 4 + ((r() * (H - 8)) | 0);
    P(x, y, 2, 2, '#120b06'); P(x, y, 1, 1, light); P(x + 1, y, 1, 1, dark);
  }
  return cv;
}

/** The cap of the timber set over the tunnel's mouth, repeated across the top of the page. */
export function beamTile(): Sprite {
  const cv = canvas(32, 12);
  const P = pen(context(cv));
  const r = rng(41);
  P(0, 0, 32, 12, 'W'); P(0, 0, 32, 1, 'h'); P(0, 10, 32, 1, 'w'); P(0, 11, 32, 1, 'k');
  for (let i = 0; i < 6; i++) P((r() * 26) | 0, 2 + ((r() * 7) | 0), 3 + ((r() * 7) | 0), 1, 'w');
  // Bark left on the rough-hewn edge, and an adze mark.
  for (let x = 0; x < 32; x += 1) if (r() < 0.35) P(x, 1, 1, 1, 'n');
  P(20, 5, 2, 2, 'n'); P(21, 5, 1, 1, 'w');
  return cv;
}

/** A post of the timber set, repeated down each side of the tunnel. */
export function postTile(): Sprite {
  const cv = canvas(8, 32);
  const P = pen(context(cv));
  const r = rng(53);
  P(0, 0, 8, 32, 'k'); P(1, 0, 6, 32, 'W'); P(1, 0, 1, 32, 'h'); P(6, 0, 1, 32, 'w');
  for (let i = 0; i < 5; i++) P(2 + ((r() * 4) | 0), (r() * 26) | 0, 1, 3 + ((r() * 6) | 0), 'w');
  P(3, 18, 2, 2, 'n'); P(3, 18, 1, 1, 'w');
  return cv;
}

/**
 * The knee brace between a post and the cap, on the left of the tunnel
 * (`/`) or on the right (`\`), each lit from the top left as it stands.
 */
function brace(side: 'l' | 'r'): Sprite {
  return maskIcon(
    12,
    12,
    (x, y) => Math.abs(side === 'l' ? x + y - 11 : x - y) <= 2,
    (x, y) => {
      const d = side === 'l' ? x + y - 11 : y - x;
      return d < -0.5 ? 'h' : d > 0.5 ? 'w' : 'W';
    },
  );
}

/**
 * The floor of the gallery: a foot of rubble against the wall, then packed
 * earth that gets lighter toward the viewer, with a mine rail laid along it.
 */
export function floorTile(): Sprite {
  const cv = canvas(48, 26);
  const P = pen(context(cv));
  const r = rng(91);
  P(0, 0, 48, 26, '#120c07');
  for (let x = 0; x < 48; x += 3 + ((r() * 3) | 0)) {
    const w = 2 + ((r() * 3) | 0);
    const h = 2 + ((r() * 2) | 0);
    P(x, 4 - h, w, h, '#3a2c20'); P(x, 4 - h, w, 1, '#4a3a2c');
  }
  P(0, 4, 48, 2, '#080503');
  const rows: readonly (readonly [number, number, readonly string[]])[] = [
    [6, 5, ['#251a11', '#22170f', '#281c12']],
    [11, 7, ['#2e2016', '#2b1e14', '#312318']],
    [18, 8, ['#36271b', '#33251a', '#3a2a1d']],
  ];
  for (const [y, h, tones] of rows) {
    P(0, y, 48, h, tones[0] ?? '#2e2016');
    for (let i = 0; i < 40; i++) P((r() * 48) | 0, y + ((r() * h) | 0), 1, 1, tones[1 + ((r() * 2) | 0)] ?? '#333');
    P(0, y, 48, 1, 'rgba(255,255,255,.04)');
  }
  for (let x = 2; x < 48; x += 6) { P(x, 13, 3, 9, 'w'); P(x, 13, 3, 1, 'h'); P(x + 3, 14, 1, 8, 'k'); }
  for (const y of [14, 20]) { P(0, y, 48, 1, 'S'); P(0, y + 1, 48, 1, 'i'); P(0, y + 2, 48, 1, 'k'); }
  return cv;
}

/** An iron chain of `links` links, hanging straight down. */
export function chain(links: number): Sprite {
  const cv = canvas(6, links * 4 + 1);
  const P = pen(context(cv));
  for (let i = 0; i < links; i++) {
    const y = i * 4;
    if (i % 2 === 0) {
      P(1, y, 4, 5, 'k'); P(2, y + 1, 2, 3, 'x'); P(1, y, 4, 1, 'I'); P(1, y, 1, 4, 'I'); P(4, y + 1, 1, 4, 'i');
    } else {
      P(2, y, 2, 5, 'k'); P(2, y + 1, 1, 3, 'I'); P(3, y + 1, 1, 3, 'i');
    }
  }
  return cv;
}

/** An iron arm nailed to a post, a hook at its end for a lamp. Points away from the post. */
function lampArm(side: 'l' | 'r'): Sprite {
  const cv = canvas(14, 7);
  const P = pen(context(cv));
  const x0 = side === 'l' ? 0 : 1;
  P(x0, 0, 13, 3, 'k'); P(x0 + 1, 1, 11, 1, 'I');
  const hook = side === 'l' ? 1 : 10;
  P(hook, 2, 3, 5, 'k'); P(hook + 1, 3, 1, 3, 'i');
  const plate = side === 'l' ? 10 : 0;
  P(plate, 0, 4, 5, 'k'); P(plate + 1, 1, 2, 3, 'i'); P(plate + 1, 1, 1, 1, 'I');
  return cv;
}

function lantern(frame: number): Sprite {
  const cv = canvas(14, 24);
  const P = pen(context(cv));
  const f = frame % 2;
  P(5, 0, 4, 2, 'k'); P(6, 0, 2, 1, 'I');
  P(3, 2, 8, 3, 'k'); P(4, 3, 6, 1, 'i');
  P(2, 5, 10, 13, 'k'); P(3, 6, 8, 11, '#e9a640'); P(4, 7, 6, 9, 'F');
  P(6, 10 - f, 2, 5 + f, 'y'); P(5 + f, 12, 1, 3, 'f');
  P(2, 5, 1, 13, 'i'); P(11, 5, 1, 13, 'i'); P(6, 5, 2, 1, 'i');
  P(3, 18, 8, 2, 'k'); P(4, 18, 6, 1, 'i'); P(6, 20, 2, 2, 'k');
  return cv;
}

/** The same lamp, set down on the floor: a carrying hoop on top and a wide foot. */
function floorLamp(frame: number): Sprite {
  const cv = canvas(14, 24);
  const P = pen(context(cv));
  const f = frame % 2;
  P(4, 0, 6, 1, 'k'); P(3, 1, 1, 3, 'k'); P(10, 1, 1, 3, 'k'); P(4, 1, 6, 1, 'i');
  P(3, 3, 8, 3, 'k'); P(4, 4, 6, 1, 'i');
  P(2, 6, 10, 12, 'k'); P(3, 7, 8, 10, '#e9a640'); P(4, 8, 6, 8, 'F');
  P(6, 11 - f, 2, 5 + f, 'y'); P(5 + f, 13, 1, 3, 'f');
  P(2, 6, 1, 12, 'i'); P(11, 6, 1, 12, 'i');
  P(1, 18, 12, 4, 'k'); P(2, 19, 10, 1, 'I'); P(2, 20, 10, 1, 'i');
  return cv;
}

function crack(seed: number): Sprite {
  const cv = canvas(12, 16);
  const P = pen(context(cv));
  const r = rng(seed);
  let x = 6;
  for (let y = 0; y < 16; y++) {
    x += r() < 0.45 ? (r() < 0.5 ? -1 : 1) : 0;
    x = Math.max(1, Math.min(10, x));
    P(x, y, 1, 1, '#0a0604');
    if (r() < 0.3) P(x + 1, y, 1, 1, '#ffffff12');
    if (y === 7) for (let k = 1; k < 5; k++) P(x + k, y + k, 1, 1, '#0a0604');
  }
  return cv;
}

/** A seam in the rock: a dark fissure with lumps of `ore` caught in it. */
function seam(seed: number, ore: 'gold' | 'coal'): Sprite {
  const cv = canvas(20, 12);
  const P = pen(context(cv));
  const r = rng(seed);
  const [light, dark] = ore === 'gold' ? ['G', 'o'] : ['A', 'a'];
  let y = 6;
  for (let x = 0; x < 20; x++) {
    y = Math.max(2, Math.min(9, y + (r() < 0.4 ? (r() < 0.5 ? -1 : 1) : 0)));
    P(x, y, 1, 2, '#0a0604');
    if (r() < (ore === 'coal' ? 0.5 : 0.32)) { P(x, y - 1, 2, 2, 'k'); P(x, y - 1, 1, 1, light); P(x + 1, y, 1, 1, dark); }
  }
  return cv;
}

/** Crystals growing out of a crack: three prisms, pointed, lit from the left. */
function crystals(): Sprite {
  return fromRows([
    '.....kk.........',
    '....kJjk........',
    '....kJjk....k...',
    '.k..kJjlk..kJk..',
    'kJk.kJjlk..kJlk.',
    'kJjkkJjlk.kJjlk.',
    'kJjlkJjlkkkJjlk.',
    'kJjlkJjlkkJjjlk.',
    'kJjlkJjlkkJjjlk.',
    'kkkkkkkkkkkkkkk.',
  ]);
}

/** A pick and a shovel crossed on a peg, as a miner leaves them on the wall. */
function minerTools(): Sprite {
  const cv = canvas(24, 24);
  const P = pen(context(cv));
  for (let i = 0; i < 18; i++) {
    P(3 + i, 3 + i, 2, 2, 'k'); P(4 + i, 3 + i, 1, 1, 'h');
    P(20 - i, 3 + i, 2, 2, 'k'); P(20 - i, 3 + i, 1, 1, 'W');
  }
  // The shovel's blade, bottom left; the pick's head, top left.
  P(0, 17, 7, 7, 'k'); P(1, 18, 5, 5, 'I'); P(1, 18, 5, 1, 'S'); P(5, 19, 1, 4, 'i');
  P(0, 2, 10, 3, 'k'); P(1, 3, 8, 1, 'S'); P(0, 5, 2, 3, 'k'); P(8, 0, 3, 3, 'k'); P(9, 1, 1, 1, 'I');
  P(10, 9, 4, 4, 'k'); P(11, 10, 2, 2, 'i');
  return cv;
}

/**
 * Crates of dynamite, nailed shut: a big one and a small one on top, each with
 * a red band and a painted stick on it.
 */
function dynamite(): Sprite {
  const cv = canvas(26, 24);
  const P = pen(context(cv));
  const crate = (x: number, y: number, w: number, h: number): void => {
    P(x, y, w, h, 'k'); P(x + 1, y + 1, w - 2, h - 2, 'W'); P(x + 1, y + 1, w - 2, 1, 'h');
    P(x + 1, y + h - 2, w - 2, 1, 'w');
    for (let i = x + 4; i < x + w - 2; i += 4) P(i, y + 2, 1, h - 4, 'w');
    const band = y + (h >> 1) - 2;
    P(x + 1, band, w - 2, 4, 'r'); P(x + 1, band, w - 2, 1, 'R');
    const mid = x + (w >> 1);
    P(mid - 3, band + 1, 6, 2, 'p'); P(mid - 2, band + 1, 3, 2, 'R'); P(mid + 1, band + 1, 1, 1, 'k');
    for (const cx of [x + 1, x + w - 2]) { P(cx, y + 1, 1, 1, 'I'); P(cx, y + h - 2, 1, 1, 'I'); }
  };
  crate(0, 10, 18, 14); crate(4, 0, 13, 11); crate(17, 13, 9, 11);
  return cv;
}

/** An iron bucket with its bail up. */
function bucket(): Sprite {
  const cv = canvas(14, 15);
  const P = pen(context(cv));
  P(3, 0, 8, 1, 'k'); P(2, 1, 1, 4, 'k'); P(11, 1, 1, 4, 'k');
  P(0, 4, 14, 3, 'k'); P(1, 5, 12, 1, 'I');
  [12, 12, 11, 11, 10, 10, 10, 9].forEach((w, i) => {
    const x = 7 - (w >> 1);
    P(x - 1, 7 + i, w + 2, 1, 'k'); P(x, 7 + i, w, 1, 'i'); P(x, 7 + i, 2, 1, 'I');
  });
  P(2, 14, 10, 1, 'k'); P(3, 9, 8, 1, 'd');
  return cv;
}

function sack(): Sprite {
  const cv = canvas(14, 15);
  const P = pen(context(cv));
  [4, 4, 6, 8, 10, 12, 12, 12, 12, 12, 12, 12, 10].forEach((w, i) => {
    const x = 7 - (w >> 1);
    P(x - 1, i + 2, w + 2, 1, 'k'); P(x, i + 2, w, 1, i > 6 ? 'C' : 'P');
  });
  P(5, 1, 4, 2, 'w'); P(6, 0, 2, 1, 'k'); P(4, 8, 1, 3, 'P'); P(9, 6, 2, 1, 'C');
  return cv;
}

function rat(frame: number): Sprite {
  // Side view, facing right. The body is a mask so every edge pixel gets its
  // outline and the inside gets three tones — back, flank, belly; the tail
  // leaves the haunch, runs along the floor and curls up at the tip.
  const cv = canvas(30, 11);
  const ctx = context(cv);
  const P = pen(ctx);
  for (const [x, y] of [[10, 6], [9, 6], [8, 6], [7, 6], [6, 7], [5, 7], [4, 7], [3, 8], [2, 8], [1, 8], [0, 7], [0, 6], [1, 5]] as const) P(x, y, 1, 1, '#b58c86');
  for (const [x, y] of [[5, 6], [3, 7], [1, 7]] as const) P(x, y, 1, 1, '#8f6964');
  ctx.translate(6, 0);
  const runs: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
    1: [[15, 17]], 2: [[8, 12], [14, 18]], 3: [[6, 19]], 4: [[5, 21]], 5: [[4, 22]], 6: [[4, 21]], 7: [[5, 19]], 8: [[7, 16]],
  };
  const inMask = (x: number, y: number): boolean => (runs[y] ?? []).some(([a, b]) => x >= a && x <= b);
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < 24; x++) {
      if (!inMask(x, y)) continue;
      const edge = !inMask(x - 1, y) || !inMask(x + 1, y) || !inMask(x, y - 1) || !inMask(x, y + 1);
      P(x, y, 1, 1, edge ? '#2a211c' : y <= 3 ? '#9c8f83' : y >= 7 ? '#c2b5a5' : '#7a6d62');
    }
  }
  P(16, 2, 1, 1, '#e29a9a'); P(15, 2, 1, 1, '#c27a7a');
  P(19, 4, 1, 1, '#120d0b'); P(19, 3, 1, 1, '#cfc6ba');
  P(22, 5, 1, 1, '#e29a9a');
  P(23, 4, 1, 1, 'rgba(220,214,204,.7)'); P(23, 6, 1, 1, 'rgba(220,214,204,.7)');
  const legs = frame % 2
    ? ([[9, 9], [9, 10], [14, 9], [14, 10]] as const)
    : ([[8, 9], [7, 10], [15, 9], [16, 10]] as const);
  for (const [x, y] of legs) P(x, y, 1, 1, y === 10 ? '#d99a92' : '#2a211c');
  return cv;
}

/** The cart, parked: the first frame of the rolling strip, on its own. */
function parkedCart(): Sprite {
  const cv = canvas(16, 16);
  context(cv).drawImage(cartStrip(), 0, 0, 16, 16, 0, 0, 16, 16);
  return cv;
}

/**
 * The scenery, as its frames. One frame for a still piece; more for the ones
 * that flicker or run, which `scene.ts` steps through.
 */
export function drawSprites(): Readonly<Record<string, readonly Sprite[]>> {
  return {
    lantern: [lantern(0), lantern(1)],
    floorLamp: [floorLamp(0), floorLamp(1)],
    armL: [lampArm('l')],
    armR: [lampArm('r')],
    braceL: [brace('l')],
    braceR: [brace('r')],
    crack: [crack(3)],
    crack2: [crack(19)],
    gold: [seam(7, 'gold')],
    gold2: [seam(23, 'gold')],
    coal: [seam(31, 'coal')],
    coal2: [seam(47, 'coal')],
    crystals: [crystals()],
    tools: [minerTools()],
    dynamite: [dynamite()],
    bucket: [bucket()],
    sack: [sack()],
    rat: [rat(0), rat(1)],
    cart: [parkedCart()],
  };
}

/**
 * Every piece of track, as CSS-ready sprites, by name.
 *
 * The names are what `mount.ts` asks the stylesheet for: `straight-0` to
 * `straight-3` and the same for every turnable kind, `rock`, `ground`, and
 * `junction-<entry>-<exits>` with the exits in N, E, S, W order — lit, or as
 * `junction-dim-…`, the branches a run did not take — and `branch-<entry>-<exit>`,
 * the one branch it took, lit, to lay over the dimmed junction.
 */
export function drawTrackArt(): Readonly<Record<string, Sprite>> {
  const art: Record<string, Sprite> = { ground: groundTile(), rock: rockTile() };
  for (const rotation of [0, 1, 2, 3]) {
    art[`straight-${rotation}`] = straightTile(rotation);
    art[`curve-${rotation}`] = curveTile(rotation);
    art[`cross-${rotation}`] = crossTile(rotation);
    art[`start-${rotation}`] = startTile(rotation);
    art[`mine-${rotation}`] = mineTile(rotation);
    art[`tunnel-${rotation}`] = tunnelTile(rotation);
  }
  for (const entry of SIDES) {
    const others = SIDES.filter((side) => side !== entry);
    for (let mask = 1; mask < 8; mask++) {
      const exits = others.filter((_, i) => (mask >> i) & 1);
      art[`junction-${entry}-${exits.join('')}`] = junctionTile(entry, exits);
      art[`junction-dim-${entry}-${exits.join('')}`] = junctionTile(entry, exits, DIM_RAIL);
    }
    for (const exit of others) art[`branch-${entry}-${exit}`] = junctionTile(entry, [exit], RAIL, false);
  }
  art['cart'] = cartStrip();
  return art;
}

/**
 * The icons the page's labels, buttons and switches wear, as CSS backgrounds:
 * `mark-<name>` for every exit mark and `type-<question type>` for every
 * badge glyph, besides the labels' own.
 */
export function drawIcons(): Readonly<Record<string, Sprite>> {
  const icons: Record<string, Sprite> = { key: keyIcon() };
  for (const [name, rows] of Object.entries(ICON_ROWS)) icons[name] = fromRows(rows);
  for (const [name, mark] of Object.entries(exitMarkSprites())) icons[`mark-${name}`] = mark;
  for (const [name, rows] of Object.entries(TYPE_GLYPHS)) icons[`type-${name}`] = fromRows(rows);
  return icons;
}
