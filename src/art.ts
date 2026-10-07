/**
 * Every sprite, icon and texture on the page, drawn pixel by pixel in code.
 *
 * The kit — the palette, `fromRows`, `maskIcon` and the seeded `rng` — comes
 * from Gridsmith's `src/ui/art.ts`, unchanged. A sprite is either a grid of
 * palette letters (`fromRows`), a shape tested per pixel (`maskIcon`) or a few
 * rectangles in a function, so each piece stays editable as text and the page
 * downloads no image at all.
 *
 * Browser only: every function here creates a `<canvas>` through `document`.
 * `scene.ts` is the one caller, and it checks for a document before it calls.
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

/** The track under a switch: from its entry to every side it can send the cart to. */
function junctionTile(entry: Side, exits: readonly Side[]): Sprite {
  return tile((P) => {
    const { runs, arcs } = laid(entry, exits);
    track(P, runs, arcs);
  });
}

// --- The three switches Jev works -----------------------------------------------
//
// Each stands in the middle of its junction, drawn the right way up whatever way
// the track runs, and each is a different machine so a glance tells them apart:
// a lever with a target disc picks one of a few ways (`choice`), a barrier arm
// says yes or no (`noul`), and a balance weighs the sentence on a scale (`score`).

function leverDevice(): Sprite {
  return tile((P) => {
    P(5, 1, 6, 6, 'k'); P(6, 2, 4, 4, 'R'); P(8, 4, 2, 2, 'r'); P(6, 3, 4, 1, 'c'); P(6, 2, 1, 1, '#e0705f');
    P(7, 7, 2, 5, 'k'); P(7, 7, 1, 5, 'I'); P(8, 7, 1, 5, 'i');
    P(9, 8, 4, 2, 'k'); P(10, 8, 2, 1, 'I'); P(12, 7, 2, 2, 'k'); P(12, 7, 1, 1, 'S');
    P(4, 11, 8, 4, 'k'); P(5, 12, 6, 1, 'h'); P(5, 13, 6, 1, 'w');
  });
}

function gateDevice(): Sprite {
  return tile((P) => {
    P(1, 3, 4, 12, 'k'); P(2, 4, 1, 10, 'I'); P(3, 4, 1, 10, 'i');
    P(0, 13, 6, 3, 'k'); P(1, 14, 4, 1, 'w');
    P(4, 6, 12, 4, 'k');
    for (let x = 5; x < 15; x++) {
      const red = ((x - 5) >> 1) % 2 === 0;
      P(x, 7, 1, 1, red ? 'R' : 'c'); P(x, 8, 1, 1, red ? 'r' : 'C');
    }
    P(1, 5, 4, 3, 'k'); P(2, 6, 2, 1, 'g');
  });
}

function scaleDevice(): Sprite {
  return tile((P) => {
    P(7, 1, 2, 2, 'k'); P(7, 1, 1, 1, 'G');
    P(1, 3, 14, 3, 'k'); P(2, 4, 12, 1, 'G'); P(7, 4, 2, 1, 'o');
    P(7, 6, 2, 7, 'k'); P(7, 6, 1, 7, 'g'); P(8, 6, 1, 7, 'o');
    for (const left of [1, 10]) {
      P(left + 2, 6, 1, 3, 'k');
      P(left, 9, 5, 3, 'k'); P(left + 1, 9, 3, 1, 'G'); P(left + 1, 10, 3, 1, 'o');
    }
    P(4, 13, 8, 3, 'k'); P(5, 14, 6, 1, 'g');
  });
}

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

// --- The gallery around the board ---------------------------------------------
//
// Scenery only, none of it read back by the game. The stone, the beam, the
// chain, the bracket, the lantern, the crack, the moss, the barrel, the crates,
// the sack and the rat are Gridsmith's, unchanged; the floor gains a rail, and
// the ore veins and the miner's tools are this page's own.

/** The wall: dark bricks in staggered rows, a little moss in the joints. */
export function stoneTile(): Sprite {
  const cv = canvas(64, 32);
  const ctx = context(cv);
  const r = rng(11);
  ctx.fillStyle = '#101115';
  ctx.fillRect(0, 0, 64, 32);
  const shades = ['#26292f', '#2b2e35', '#23252b', '#2f333a', '#272a30'];
  for (let row = 0; row < 4; row++) {
    const off = row % 2 ? 8 : 0;
    for (let bx = -off; bx < 64; bx += 16) {
      const x = bx + 1;
      const y = row * 8 + 1;
      ctx.fillStyle = shades[(r() * shades.length) | 0] ?? shades[0];
      ctx.fillRect(x, y, 15, 7);
      ctx.fillStyle = '#ffffff10';
      ctx.fillRect(x, y, 15, 1);
      ctx.fillStyle = '#00000040';
      ctx.fillRect(x, y + 6, 15, 1);
      if (r() < 0.18) {
        ctx.fillStyle = '#2d4528';
        ctx.fillRect(x + ((r() * 12) | 0), y + 6, 3, 1);
      }
    }
  }
  return cv;
}

/** The ceiling beam, repeated across the top of the page. */
export function beamTile(): Sprite {
  const cv = canvas(32, 12);
  const P = pen(context(cv));
  const r = rng(41);
  P(0, 0, 32, 12, 'W'); P(0, 0, 32, 1, 'h'); P(0, 10, 32, 1, 'w'); P(0, 11, 32, 1, 'k');
  for (let i = 0; i < 6; i++) P((r() * 26) | 0, 2 + ((r() * 7) | 0), 3 + ((r() * 7) | 0), 1, 'w');
  P(20, 5, 2, 2, 'n'); P(21, 5, 1, 1, 'w');
  return cv;
}

/**
 * The floor: Gridsmith's stone skirting and three rows of flags that get
 * taller and lighter toward the viewer, with a mine rail laid along the
 * nearest row, so the gallery's floor is the track's floor.
 */
export function floorTile(): Sprite {
  const cv = canvas(48, 26);
  const P = pen(context(cv));
  const r = rng(91);
  P(0, 0, 48, 26, '#101114');
  for (let x = 0; x < 48; x += 12) {
    P(x, 0, 11, 4, '#4a4e56'); P(x, 0, 11, 1, '#6b7079'); P(x, 3, 11, 1, '#33363c');
  }
  P(0, 4, 48, 2, '#08090a');
  const rows: readonly (readonly [number, number, number, readonly string[]])[] = [
    [6, 5, 8, ['#2a2c31', '#26282d', '#2d2f35']],
    [12, 6, 12, ['#33363c', '#2f3237', '#373a40']],
    [19, 7, 16, ['#3c3f46', '#383b41', '#41444b']],
  ];
  for (const [y, h, w, tones] of rows) {
    const off = (y % 2) * (w / 2);
    for (let x = -off; x < 48; x += w) {
      P(x + 1, y, w - 1, h - 1, tones[(r() * tones.length) | 0] ?? tones[0] ?? '#333');
      P(x + 1, y, w - 1, 1, 'rgba(255,255,255,.07)');
      if (r() < 0.35) P(x + 2 + ((r() * (w - 5)) | 0), y + 2, 2, 1, 'rgba(0,0,0,.25)');
    }
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

function bracket(): Sprite {
  const cv = canvas(8, 14);
  const P = pen(context(cv));
  P(0, 0, 8, 14, 'k'); P(1, 0, 6, 13, 'i'); P(1, 0, 6, 1, 'I'); P(1, 0, 1, 13, 'I');
  P(3, 3, 2, 2, 'I'); P(3, 9, 2, 2, 'I'); P(4, 4, 1, 1, 'k'); P(4, 10, 1, 1, 'k');
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

function crack(seed: number): Sprite {
  const cv = canvas(12, 16);
  const P = pen(context(cv));
  const r = rng(seed);
  let x = 6;
  for (let y = 0; y < 16; y++) {
    x += r() < 0.45 ? (r() < 0.5 ? -1 : 1) : 0;
    x = Math.max(1, Math.min(10, x));
    P(x, y, 1, 1, '#08080a');
    if (r() < 0.3) P(x + 1, y, 1, 1, '#ffffff12');
    if (y === 7) for (let k = 1; k < 5; k++) P(x + k, y + k, 1, 1, '#08080a');
  }
  return cv;
}

function moss(): Sprite {
  const cv = canvas(12, 6);
  const P = pen(context(cv));
  const r = rng(5);
  const greens = ['M', 'm', '#24451f'];
  for (let i = 0; i < 30; i++) {
    const x = (r() * 12) | 0;
    const y = (r() * 6) | 0;
    if (Math.abs(x - 6) / 6 + y / 6 < 1.1) P(x, y, 1, 1, greens[(r() * 3) | 0] ?? 'M');
  }
  return cv;
}

/** A seam of gold in the rock: a dark fissure with nuggets caught in it. */
function oreVein(seed: number): Sprite {
  const cv = canvas(20, 12);
  const P = pen(context(cv));
  const r = rng(seed);
  let y = 6;
  for (let x = 0; x < 20; x++) {
    y = Math.max(2, Math.min(9, y + (r() < 0.4 ? (r() < 0.5 ? -1 : 1) : 0)));
    P(x, y, 1, 2, '#0c0b0c');
    if (r() < 0.32) { P(x, y - 1, 2, 2, 'k'); P(x, y - 1, 1, 1, 'G'); P(x + 1, y, 1, 1, 'o'); }
  }
  return cv;
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
  P(10, 9, 4, 4, 'k'); P(11, 10, 2, 2, 'g');
  return cv;
}

function barrel(): Sprite {
  const cv = canvas(18, 22);
  const P = pen(context(cv));
  P(2, 0, 14, 22, 'k'); P(1, 3, 16, 16, 'k'); P(3, 1, 12, 20, 'W'); P(2, 4, 14, 14, 'W');
  P(6, 1, 1, 20, 'w'); P(11, 1, 1, 20, 'w'); P(4, 2, 1, 18, 'h');
  P(1, 5, 16, 2, 'i'); P(1, 15, 16, 2, 'i'); P(1, 5, 16, 1, 'I'); P(1, 15, 16, 1, 'I');
  return cv;
}

function crates(): Sprite {
  const cv = canvas(26, 24);
  const P = pen(context(cv));
  const crate = (x: number, y: number, w: number, h: number): void => {
    P(x, y, w, h, 'k'); P(x + 1, y + 1, w - 2, h - 2, 'W'); P(x + 1, y + 1, w - 2, 1, 'h');
    for (let i = 0; i < w - 4; i++) P(x + 2 + i, y + 2 + Math.round((i * (h - 5)) / (w - 5)), 1, 1, 'w');
    P(x + 1, y + (h >> 1), w - 2, 1, 'w');
  };
  crate(0, 11, 16, 13); crate(15, 14, 11, 10); crate(3, 0, 12, 11);
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
    bracket: [bracket()],
    lantern: [lantern(0), lantern(1)],
    crack: [crack(3)],
    crack2: [crack(19)],
    moss: [moss()],
    vein: [oreVein(7)],
    vein2: [oreVein(23)],
    tools: [minerTools()],
    barrel: [barrel()],
    crates: [crates()],
    sack: [sack()],
    rat: [rat(0), rat(1)],
    cart: [parkedCart()],
  };
}

/**
 * Every piece of track and every switch, as CSS-ready sprites, by name.
 *
 * The names are what `mount.ts` asks the stylesheet for: `straight-0` to
 * `straight-3` and the same for every turnable kind, `rock`, `ground`,
 * `junction-<entry>-<exits>` with the exits in N, E, S, W order, and
 * `device-<question type>`.
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
    }
  }
  art['device-choice'] = leverDevice();
  art['device-noul'] = gateDevice();
  art['device-score'] = scaleDevice();
  art['cart'] = cartStrip();
  return art;
}

/** The icons the page's labels and buttons wear, as CSS backgrounds. */
export function drawIcons(): Readonly<Record<string, Sprite>> {
  const icons: Record<string, Sprite> = { key: keyIcon() };
  for (const [name, rows] of Object.entries(ICON_ROWS)) icons[name] = fromRows(rows);
  return icons;
}
