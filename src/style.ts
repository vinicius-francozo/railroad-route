/**
 * The page's stylesheet: a mine gallery, a wooden plaque, two framed boards.
 *
 * One string, put into a `<style>` by `mountApp`, so the page is still the one
 * module that touches the document. The tokens at the top are the design
 * system's, copied from Gridsmith's `src/ui/style.ts`; where a written guide
 * and these values disagree, these win.
 *
 * Every picture this refers to arrives as a `--rr-art-*` custom property that
 * `scene.ts` sets once the pixels are drawn. Each use has a fallback, so a page
 * with no scenery (the tests, or a browser where the drawing failed) is plain
 * but whole.
 */

/** The four families, self-hosted from `public/fonts` under the OFL. */
const FONT_FACES = (
  [
    ['Alegreya Sans', 400, 'alegreya-sans-400'],
    ['Alegreya Sans', 500, 'alegreya-sans-500'],
    ['Alegreya Sans', 700, 'alegreya-sans-700'],
    ['Jersey 10', 400, 'jersey-10-400'],
    ['Pixelify Sans', 700, 'pixelify-sans-700'],
    ['VT323', 400, 'vt323-400'],
  ] as const
)
  .flatMap(([family, weight, file]) => [
    `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap;
  src: url(/fonts/${file}-latin-ext.woff2) format("woff2");
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }`,
    `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap;
  src: url(/fonts/${file}-latin.woff2) format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }`,
  ])
  .join('\n');

const TOKENS = `
:root {
  color-scheme: dark;
  --wall: #1b1d22; --board: #1f2126; --well: #14161a;
  --wood: #4a2f1e; --wood-hi: #7a4d2b; --wood-lo: #2c1b10;
  --gold: #d9a441; --gold-hi: #f2cf72; --gold-lo: #8a6424;
  --parch: #e8d6a8; --parch-lo: #bfa877;
  --ink: #ece3cf; --ink-dim: #b3a990; --ink-dark: #2a1a0e;
  --moss: #3f7a3a; --moss-hi: #6cb35f; --moss-lo: #1f3d22;
  --ember: #f08a2c; --ok: #5fbf5a; --warn: #e0a83a; --danger: #d4604a;
  --line: #4d525c;

  --f-display: "Jersey 10", "VT323", ui-monospace, monospace;
  --f-brand: "Pixelify Sans", "Jersey 10", ui-monospace, monospace;
  --f-body: "Alegreya Sans", "Segoe UI", system-ui, sans-serif;
  --f-num: "VT323", ui-monospace, "Cascadia Mono", monospace;

  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;

  --floor-h: clamp(26px, 5.4vh, 64px);
  --floor-gap: clamp(6px, 1.3vh, 14px);
  --hall-top: clamp(12px, 2.6vh, 30px);
}`;

const BASE = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; background: var(--wall); overflow-x: clip; }
body {
  margin: 0; color: var(--ink); font: 400 16px/1.45 var(--f-body);
  display: flex; flex-direction: column; height: 100dvh; overflow: hidden;
  padding: 0 16px calc(var(--floor-h) + var(--floor-gap));
  background-color: var(--wall); background-image: var(--rr-art-stone, none);
  background-size: 192px 96px; background-repeat: repeat; image-rendering: pixelated;
}
/* the gallery darkens toward its corners */
body::before {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(ellipse 75% 70% at 50% 35%, transparent 55%, rgba(0,0,0,.55) 100%);
}
#app { flex: 1; min-height: 0; display: flex; flex-direction: column; }
:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
.rr-px { image-rendering: pixelated; display: block; }
`;

export const STYLE = [FONT_FACES, TOKENS, BASE].join('\n');
