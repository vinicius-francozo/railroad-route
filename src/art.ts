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
