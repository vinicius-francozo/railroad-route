/**
 * The page's stylesheet: a mine — earth all round, a timbered tunnel mouth in
 * the middle, a wooden plaque and two boards inside it.
 *
 * One string, put into a `<style>` by `mountApp`, so the page is still the one
 * module that touches the document. The tokens at the top are the design
 * system's, copied from Gridsmith's `src/ui/style.ts`, with the surfaces moved
 * from its grey stone to the mine's dark earth; the text colours are its own,
 * and every pair was measured again on the new surfaces (WCAG 2): `--ink` on
 * `--board` 13.5:1, on `--well` 14.9:1; `--ink-dim` on `--board` 7.4:1, on
 * `--well` 8.2:1, on the readings 7.8:1; `--gold-hi` on `--board` 11.4:1;
 * `--parch` on `--board` 12.0:1; `--danger` on `--board` 5.8:1. Where a
 * written guide and these values disagree, these win.
 *
 * Every picture this refers to arrives as a `--rr-art-*` custom property that
 * `scene.ts` sets once the pixels are drawn. Each use has a fallback, so a page
 * with no scenery (the tests, or a browser where the drawing failed) is plain
 * but whole.
 */

/**
 * How long the cart spends on each square, as every sprite frame in the design
 * system. Here because the stylesheet's step transition and the page's loop in
 * `mount.ts` have to agree on it.
 */
export const FRAME_MS = 220;

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
  --wall: #1d140d; --board: #211a14; --well: #140f0b; --panel: #1a1410;
  --wood: #4a2f1e; --wood-hi: #7a4d2b; --wood-lo: #2c1b10;
  --gold: #d9a441; --gold-hi: #f2cf72; --gold-lo: #8a6424;
  --parch: #e8d6a8; --parch-lo: #bfa877;
  --ink: #ece3cf; --ink-dim: #b3a990; --ink-dark: #2a1a0e;
  --moss: #3f7a3a; --moss-hi: #6cb35f; --moss-lo: #1f3d22;
  --ember: #f08a2c; --ok: #5fbf5a; --warn: #e0a83a; --danger: #e57560;
  --line: #5b4b3d;
  /* the light of a lamp: three hard rings, no blur, as a pixel-art glow */
  --lamp-light: radial-gradient(circle, rgba(255,176,82,.26) 0 22%, rgba(255,156,64,.15) 22% 42%, rgba(240,138,44,.07) 42% 64%, transparent 64%);

  --f-display: "Jersey 10", "VT323", ui-monospace, monospace;
  --f-brand: "Pixelify Sans", "Jersey 10", ui-monospace, monospace;
  --f-body: "Alegreya Sans", "Segoe UI", system-ui, sans-serif;
  --f-num: "VT323", ui-monospace, "Cascadia Mono", monospace;

  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;

  --floor-h: clamp(26px, 5.4vh, 64px);
  --floor-gap: clamp(6px, 1.3vh, 14px);
  --hall-top: clamp(12px, 2.6vh, 30px);
  /* how far the tunnel's timber posts stand out from the boards, when there is room for them */
  --post-w: 0px; --post-gap: 0px;
}`;

const BASE = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; background: var(--wall); overflow-x: clip; }
body {
  margin: 0; color: var(--ink); font: 400 16px/1.45 var(--f-body);
  display: flex; flex-direction: column; height: 100dvh; overflow: hidden;
  padding: 0 16px calc(var(--floor-h) + var(--floor-gap));
  background-color: var(--wall); background-image: var(--rr-art-earth-bits, none), var(--rr-art-earth, none);
  background-size: 672px 456px, 480px 336px; background-repeat: repeat; image-rendering: pixelated;
}
/* underground, the dark closes in from every edge */
body::before {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(ellipse 72% 68% at 50% 38%, transparent 38%, rgba(0,0,0,.5) 72%, rgba(0,0,0,.78) 100%);
}
#app { flex: 1; min-height: 0; display: flex; flex-direction: column; }
:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
.rr-px { image-rendering: pixelated; display: block; }

/* an icon is a picture before the words, drawn by scene.ts */
.rr-icon::before {
  content: ""; flex: none; width: 24px; height: 24px;
  background: center / contain no-repeat; image-rendering: pixelated;
}
.rr-icon-pickaxe::before { background-image: var(--rr-art-pickaxe, none); }
.rr-icon-scroll::before { background-image: var(--rr-art-scroll, none); }
.rr-icon-key::before { background-image: var(--rr-art-key, none); }
.rr-icon-takeback::before { background-image: var(--rr-art-takeback, none); }
.rr-icon-cart::before { width: 32px; height: 32px; background: var(--rr-art-cart, none) 0 0 / 200% 100% no-repeat; }
.rr-icon-crate-straight::before { width: 32px; height: 32px; background-image: var(--rr-art-straight-0, none); }
.rr-icon-crate-curve::before { width: 32px; height: 32px; background-image: var(--rr-art-curve-0, none); }
.rr-icon-crate-cross::before { width: 32px; height: 32px; background-image: var(--rr-art-cross-0, none); }

/* a switch's badge in the list: a glyph for its kind and its letter, in ink on
   a parchment plate. Sized in --u, one sprite pixel, three screen pixels, so
   its glyph is drawn at a whole scale. (On the board it is the letter alone:
   see .rr-grid .rr-badge.) */
.rr-badge { --u: 3px; display: inline-flex; align-items: center; gap: var(--u); pointer-events: none;
  height: calc(var(--u) * 7); padding: 0 var(--u) 0 var(--u);
  font: 400 calc(var(--u) * 7.4)/1 var(--f-num); color: #1a1410; background: var(--parch);
  box-shadow: inset 0 calc(var(--u) * -1) 0 var(--parch-lo), 0 0 0 var(--u) #1a1410, var(--u) var(--u) 0 var(--u) rgba(0,0,0,.6); }
.rr-badge::before { content: ""; flex: none; width: calc(var(--u) * 5); height: calc(var(--u) * 5);
  background: 0 0 / 100% 100% no-repeat; image-rendering: pixelated; }
:root:not([data-art]) .rr-badge::before { display: none; }
.rr-type-choice::before { background-image: var(--rr-art-type-choice, none); }
.rr-type-noul::before { background-image: var(--rr-art-type-noul, none); }
.rr-type-score::before { background-image: var(--rr-art-type-score, none); }
`;

const LAYOUT = `
.rr-app { flex: 1; min-height: 0; width: 100%; max-width: 1280px; margin: 0 auto;
  display: flex; flex-direction: column; position: relative; z-index: 1; }

/* the hall: a plaque hung from the beam, between two lanterns */
.rr-hall { flex: none; position: relative; width: 100%;
  display: grid; grid-template-columns: 1fr auto auto auto 1fr; align-items: start;
  gap: clamp(12px, 2vw, 24px); padding-block: var(--hall-top) clamp(8px, 1.6vh, 16px);
  /* the lamps' light spreads wider than a narrow screen: it must not make the page scroll sideways */
  overflow-x: clip; }
.rr-hall > * { position: relative; z-index: 1; }
/* but not the lamps: a lamp's light falls on the rock and the timbers behind
   the plaque and the boards, never on them, so its wrap makes no stacking
   context of its own and the light sinks to the back of the tunnel's */
.rr-hall > .rr-lantern-wrap { z-index: auto; }
.rr-plaque { grid-column: 3; position: relative; text-align: center;
  padding: clamp(6px, 1.2vh, 12px) clamp(16px, 2.4vw, 32px) clamp(8px, 1.6vh, 16px);
  background: linear-gradient(#5a3820, #432916); border: 4px solid var(--wood-lo);
  box-shadow: inset 0 0 0 3px var(--gold-lo), inset 0 0 0 5px var(--wood-lo), 5px 7px 0 #0008; }
.rr-brand { display: flex; align-items: center; justify-content: center; gap: var(--s3); }
.rr-brand::before { content: ""; height: clamp(32px, 4.8vh, 48px); aspect-ratio: 1;
  background: var(--rr-art-cart, none) 0 0 / 200% 100% no-repeat; image-rendering: pixelated;
  filter: drop-shadow(2px 3px 0 rgba(0,0,0,.38)); }
.rr-brand h1 { margin: 0; font: 700 clamp(26px, 5vh, 54px)/1 var(--f-brand); color: var(--gold-hi);
  letter-spacing: .02em; text-shadow: 3px 3px 0 #2a1608, -1px -1px 0 #f7dc8f55; }
.rr-tagline { margin: clamp(2px, .8vh, 8px) 0 0; font: 400 clamp(15px, 2.1vh, 21px)/1.15 var(--f-display);
  color: var(--parch); text-shadow: 2px 2px 0 #1a0e05; text-wrap: balance; }

/* the boards: the plan on the left, the track (the larger) on the right */
.rr-layout { flex: 1; min-height: 0; width: 100%; display: grid; gap: var(--s5); align-items: stretch;
  grid-template-columns: minmax(320px, clamp(340px, 30vw, 420px)) minmax(0, 1fr); }
.rr-board { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--board); border: 4px solid var(--wood);
  padding: clamp(14px, 2.2vh, 24px) clamp(16px, 1.8vw, 24px);
  box-shadow: inset 0 0 0 2px var(--wood-hi), inset 0 0 0 4px var(--wood-lo), 0 0 0 2px #000a, 6px 8px 0 #0007; }
.rr-board-body { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px;
  scrollbar-width: thin; scrollbar-color: var(--wood-hi) transparent; }
.rr-tag { display: inline-flex; align-items: center; gap: var(--s2);
  margin: calc(-1 * var(--s2)) 0 clamp(8px, 1.6vh, 16px); padding: var(--s2) var(--s4);
  color: var(--ink-dark); font: 400 clamp(25px, 3.4vh, 30px)/1 var(--f-display); letter-spacing: .02em;
  background-color: var(--parch);
  background-image: radial-gradient(ellipse at 50% 45%, transparent 52%, rgba(122,82,34,.32) 100%);
  clip-path: polygon(6px 0, calc(100% - 6px) 0, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) 100%, 6px 100%, 0 calc(100% - 6px), 0 6px);
  box-shadow: inset 0 -4px 0 #b39461, inset 0 0 0 2px #c4a96f, inset 3px 3px 0 #f6ead0;
  text-shadow: 1px 1px 0 #f6ead0; }
`;

const FORM = `
.rr-field { display: grid; gap: clamp(4px, .8vh, 8px); margin-bottom: clamp(8px, 1.5vh, 16px); }
.rr-label { display: flex; align-items: center; gap: var(--s2);
  font: 400 22px/1 var(--f-display); color: var(--gold-hi); letter-spacing: .03em; }
.rr-field textarea, .rr-field select, .rr-field input {
  width: 100%; color: var(--ink); background: var(--well); border: 2px solid var(--line); border-radius: 0;
  box-shadow: inset 0 3px 0 #0009; font: 400 17px/1.35 var(--f-body); padding: 10px 12px; }
.rr-field textarea { resize: vertical; min-height: 0; height: clamp(66px, 9.5vh, 88px); }
.rr-field select { appearance: none; padding-right: 36px; text-overflow: ellipsis;
  background-image: linear-gradient(45deg, transparent 50%, var(--gold) 50%), linear-gradient(-45deg, transparent 50%, var(--gold) 50%);
  background-position: calc(100% - 18px) 50%, calc(100% - 12px) 50%; background-size: 6px 6px; background-repeat: no-repeat; }
.rr-field option { background: var(--well); color: var(--ink); }
.rr-note { margin: 0; font-size: clamp(12.5px, 1.6vh, 14px); line-height: 1.32; color: var(--ink-dim); max-width: 60ch; }
.rr-count { margin: 0; font: 400 20px/1 var(--f-num); color: var(--ink-dim); font-variant-numeric: tabular-nums; }
.rr-count[data-over="true"] { color: var(--danger); }
.rr-warning { margin: 0; font-size: 15px; color: #f3d6cf; }
.rr-warning:empty { display: none; }
.rr-warning:not(:empty) { padding: var(--s1) var(--s3); background: #251d10; border-left: 6px solid var(--warn); }

/* what each switch asks, and where each answer leads */
.rr-switches { margin-bottom: clamp(8px, 1.5vh, 16px); }
.rr-switches h3 { margin: 0 0 var(--s2); font: 400 22px/1 var(--f-display); color: var(--gold-hi); letter-spacing: .03em; }
.rr-switches > ul { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--s2); }
.rr-switch { display: grid; grid-template-columns: auto 1fr; column-gap: var(--s3); align-items: start;
  padding: var(--s2) var(--s2) var(--s2) var(--s3); background: var(--well); border: 2px solid var(--line); box-shadow: inset 0 3px 0 #0009; }
.rr-switch > .rr-badge { grid-row: 1 / span 2; margin-top: 3px; }
.rr-switch-title { margin: 0; font-weight: 700; font-size: 15.5px; line-height: 1.3; }
.rr-exits { margin: var(--s1) 0 0; padding: 0; list-style: none; display: grid; gap: 3px; font-size: 14.5px; line-height: 1.3; }
/* the mark that stands at the end of the answer's branch on the board */
.rr-exit-mark { display: inline-block; width: 18px; height: 18px; margin-right: 6px; vertical-align: -3px;
  background: var(--mark, none) 0 0 / 100% 100% no-repeat; image-rendering: pixelated; }
.rr-exits strong { color: var(--gold-hi); }
.rr-exit-side { color: var(--ink-dim); white-space: nowrap; }
.rr-taboo { margin-bottom: clamp(8px, 1.5vh, 16px); }
.rr-taboo:has(+ .rr-taboo-global:not([hidden])) { margin-bottom: var(--s1); }
.rr-taboo-global { margin-bottom: clamp(8px, 1.5vh, 16px); }
.rr-taboo-global summary { width: fit-content; cursor: pointer; }
.rr-taboo-global p { margin: var(--s1) 0 0; }

/* under the scrolling form: the note, the button, the failure */
.rr-plan-foot { flex: none; padding-top: clamp(8px, 1.4vh, 12px); border-top: 2px solid #ffffff10; }
.rr-plan-foot .rr-field { margin-bottom: var(--s2); }
.rr-plan-foot .rr-failure { max-height: 30vh; overflow-y: auto; }

/* the one main button */
.rr-go { width: 100%; height: 52px; margin: 0; padding: 0 14px; cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  font: 400 clamp(25px, 3.2vh, 29px)/1 var(--f-display); color: #f4f1e2; letter-spacing: .03em;
  text-shadow: 2px 2px 0 var(--moss-lo); background: var(--moss); border: 3px solid var(--gold-lo);
  box-shadow: inset 0 4px 0 var(--moss-hi), inset 0 -5px 0 var(--moss-lo), 0 0 0 2px #000, 0 5px 0 #0008; }
.rr-go:hover { filter: brightness(1.08); }
.rr-go:active { transform: translateY(2px);
  box-shadow: inset 0 4px 0 var(--moss-hi), inset 0 -3px 0 var(--moss-lo), 0 0 0 2px #000, 0 3px 0 #0008; }
.rr-go:disabled { cursor: default; filter: saturate(.4) brightness(.8); transform: none; }

.rr-failure { margin-top: var(--s3); padding: var(--s3) var(--s4); color: #f3d6cf; font-size: 15px;
  background: #2a1512; border: 2px solid var(--danger); border-left-width: 6px; }
.rr-failure p { margin: 0; }
.rr-failure p:first-child { font: 400 21px/1.1 var(--f-display); color: #ffb9a8; }
.rr-failure .rr-detail { margin-top: var(--s1); font: 400 13px/1.4 ui-monospace, monospace;
  color: #e3b3a8; overflow-wrap: anywhere; }
`;

const TRACK = `
.rr-track-head { flex: none; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: var(--s3); margin-bottom: clamp(8px, 1.4vh, 16px); }
.rr-track-title { margin: 0; font: 400 31px/1 var(--f-display); color: var(--parch); }
.rr-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
.rr-tool { display: inline-flex; align-items: center; gap: var(--s1); height: 40px; padding: 0 10px 0 4px; cursor: pointer;
  font: 400 21px/1 var(--f-display); color: var(--ink); background: var(--well); border: 2px solid var(--line); }
.rr-tool:hover:not(:disabled) { border-color: var(--ink-dim); }
.rr-tool:disabled { cursor: default; opacity: .45; }
.rr-tool[aria-pressed="true"] { border-color: var(--ok); box-shadow: inset 0 -3px 0 #2f6b2c; }

/* the board and, once there is a run, what Jev read beside it */
.rr-track-body { flex: 1; min-height: 0; display: flex; gap: clamp(8px, 1.4vw, 16px); }

/* the board: a well, with the track at a whole multiple of its 16-pixel sprites */
.rr-viewport { position: relative; flex: 1; min-height: 0; overflow: auto; container-type: size;
  display: grid; align-items: safe center; justify-items: safe center;
  padding: clamp(8px, 1.6vh, 24px); background: var(--well);
  border: 2px solid #0008; box-shadow: inset 0 0 0 2px #2e241b; }
.rr-grid { --cell: 48px; --u: calc(var(--cell) / 16); position: relative; display: grid;
  grid-template-columns: repeat(var(--w), var(--cell)); grid-auto-rows: var(--cell);
  box-shadow: 0 0 0 2px #000, 4px 5px 0 #0008; transition: opacity .2s; }
@supports (width: round(down, 10px, 4px)) {
  .rr-grid { --cell: clamp(32px, round(down, min(100cqw / var(--w), 100cqh / var(--h)), 16px), 64px); }
}
.rr-cell { position: relative; width: var(--cell); height: var(--cell); padding: 0; margin: 0; border: 0; cursor: pointer;
  background: #26221e var(--rr-art-ground, none) 0 0 / 100% 100%; image-rendering: pixelated; color: var(--ink); }
/* above a neighbour's switch letter (z-index 2), so no letter breaks the ring */
.rr-cell:focus-visible { z-index: 3; }
.rr-piece { position: absolute; inset: 0; display: grid; place-items: center;
  font: 400 calc(var(--cell) * .7)/1 var(--f-num); color: var(--ink-dim);
  background-image: var(--art, none); background-size: 100% 100%; background-repeat: no-repeat;
  image-rendering: pixelated; pointer-events: none; }
:root[data-art] .rr-piece { color: transparent; }
.rr-cell[data-mode="rotatable"]::after, .rr-cell[data-mode="placed"]::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(217,164,65,.55); }
.rr-cell[data-mode="placed"]::after { box-shadow: inset 0 0 0 2px rgba(108,179,95,.7); }
.rr-grid[data-tool="place"] .rr-cell[data-kind="empty"]:hover,
.rr-grid[data-tool="takeback"] .rr-cell[data-mode="placed"]:hover { box-shadow: inset 0 0 0 3px var(--gold-hi); }
.rr-cell[data-kind="switch"], .rr-cell[data-mode="fixed"] { cursor: default; }
/* an empty square takes a click only with a piece from the crate in hand */
.rr-grid:not([data-tool="place"]) > [data-kind="empty"] { cursor: default; }
/* a switch on the board: a mark stands between the rails at the end of every
   branch, and its letter sits inside the square, in the corner across from the
   entry that no rail and no mark reaches — three track pixels by four, too
   small for the list's badge, so the board shows the letter alone on its
   plate, a 5 x 7 sprite at half a track pixel (--px, rounded down to a whole
   screen pixel), clear of the neighbours and of the focus ring outside the
   square. After a run the branch the cart took stays bright, its mark ringed
   in gold, and the others go dark. */
.rr-grid .rr-badge { --px: 1px; position: absolute; z-index: 2; width: calc(var(--px) * 5); height: calc(var(--px) * 7);
  padding: 0; gap: 0; justify-content: center; font: 400 calc(var(--px) * 8)/1 var(--f-num); box-shadow: none;
  background: var(--letter, none) 0 0 / 100% 100% no-repeat, var(--parch); image-rendering: pixelated; }
:root[data-art] .rr-grid .rr-badge { color: transparent; }
.rr-grid .rr-badge::before { display: none; }
@supports (width: round(down, 10px, 4px)) { .rr-grid .rr-badge { --px: round(down, var(--cell) / 32, 1px); } }
.rr-badge[data-corner="ne"] { top: var(--px); right: var(--px); }
.rr-badge[data-corner="nw"] { top: var(--px); left: var(--px); }
.rr-badge[data-corner="se"] { bottom: var(--px); right: var(--px); }
.rr-badge[data-corner="sw"] { bottom: var(--px); left: var(--px); }
.rr-mark { position: absolute; z-index: 1; width: calc(var(--u) * 6); height: calc(var(--u) * 6); pointer-events: none;
  background: var(--mark, none) 0 0 / 100% 100% no-repeat; image-rendering: pixelated;
  filter: drop-shadow(var(--u) var(--u) 0 rgba(0,0,0,.55)); }
.rr-mark[data-side="N"] { top: 0; left: calc(var(--u) * 5); }
.rr-mark[data-side="S"] { bottom: 0; left: calc(var(--u) * 5); }
.rr-mark[data-side="E"] { right: 0; top: calc(var(--u) * 5); }
.rr-mark[data-side="W"] { left: 0; top: calc(var(--u) * 5); }
.rr-cell[data-taken] .rr-mark { opacity: .75; filter: grayscale(1) brightness(.9); }
.rr-cell[data-taken="N"] .rr-mark[data-side="N"], .rr-cell[data-taken="E"] .rr-mark[data-side="E"],
.rr-cell[data-taken="S"] .rr-mark[data-side="S"], .rr-cell[data-taken="W"] .rr-mark[data-side="W"] {
  opacity: 1; filter: none; box-shadow: 0 0 0 var(--u) var(--gold-hi); }
.rr-cell[data-trail] .rr-piece { box-shadow: inset 0 0 0 999px rgba(242,207,114,.14); }
.rr-track-board[aria-busy="true"] .rr-cell { cursor: progress; }
.rr-empty { margin: 0; display: grid; place-items: center; padding: var(--s4); min-height: 160px; align-self: stretch; justify-self: stretch;
  text-align: center; font: 400 clamp(20px, 2.8vh, 26px)/1.2 var(--f-display); color: var(--ink-dim);
  border: 2px dashed #ffffff1a; }

/* the cart rolls from square to square in four hard steps, its wheels in two */
.rr-cart { position: absolute; left: 0; top: 0; z-index: 3; width: var(--cell); height: var(--cell); pointer-events: none;
  background: var(--rr-art-cart, linear-gradient(var(--gold), var(--gold))) 0 0 / 200% 100% no-repeat; image-rendering: pixelated;
  transform: translate(calc(var(--cx, 0) * var(--cell)), calc(var(--cy, 0) * var(--cell)));
  transition: transform ${String(FRAME_MS)}ms steps(4, end); filter: drop-shadow(2px 3px 0 rgba(0,0,0,.5)); }
.rr-cart[data-moving] { animation: rr-roll ${String(FRAME_MS * 2)}ms steps(2) infinite; }
@keyframes rr-roll { from { background-position: 0 0; } to { background-position: calc(-2 * var(--cell)) 0; } }
.rr-cart[data-end="arrived"] { animation: rr-in .66s steps(3) forwards; }
@keyframes rr-in { to { opacity: 0; scale: .4; } }
.rr-cart[data-end="derailed"] { animation: rr-tip .66s steps(3) forwards; }
@keyframes rr-tip { to { rotate: 35deg; translate: 10% 15%; } }
.rr-cart[data-end="wrong_tunnel"] { animation: rr-dark .66s steps(3) forwards; }
@keyframes rr-dark { to { opacity: .15; } }
.rr-cart[data-end="loop"] { animation: rr-blink .44s steps(2) 4; }
@keyframes rr-blink { 50% { opacity: .2; } }

/* what Jev read, under the board */
.rr-readings { flex: none; width: clamp(240px, 24vw, 320px); padding: var(--s3) var(--s4);
  overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--wood-hi) transparent; background: var(--panel); border: 2px solid #45372b; border-left: 6px solid var(--gold); }
.rr-readings:empty { display: none; }
.rr-readings h2 { margin: 0 0 var(--s1); font: 400 22px/1.1 var(--f-display); color: var(--gold-hi); }
.rr-stars { margin: 0 0 var(--s2); font: 400 30px/1 var(--f-num); color: var(--gold-hi); letter-spacing: .1em; text-shadow: 2px 2px 0 #000; }
.rr-readings ul { margin: 0 0 var(--s2); padding: 0; list-style: none; display: grid; gap: var(--s2); }
.rr-readings li { padding-left: var(--s3); border-left: 3px solid var(--ok); }
.rr-readings li[data-clean="false"] { border-left-color: var(--warn); }
.rr-reading-title { margin: 0; font-weight: 700; font-size: 15px; }
.rr-verdict { margin: 0; font-size: 15px; color: var(--ink-dim); }

.rr-track-foot { flex: none; margin-top: clamp(8px, 1.4vh, 16px); padding-top: clamp(6px, 1.1vh, 12px);
  border-top: 2px solid #ffffff10; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s1) var(--s4); }
.rr-status { margin: 0; min-height: 1.45em; display: flex; align-items: center; gap: var(--s2);
  font-size: 15px; color: var(--ink-dim); }
.rr-status::before { content: ""; flex: none; width: 10px; height: 10px; background: var(--ok); box-shadow: 0 0 0 2px #0008; }
.rr-status:empty::before { background: var(--line); }
.rr-track-board[aria-busy="true"] .rr-status::before { background: var(--ember); animation: rr-blink-dot 1s steps(2) infinite; }
@keyframes rr-blink-dot { 50% { opacity: .3; } }
.rr-quota { margin: 0; font: 400 20px/1 var(--f-num); color: var(--ink-dim); font-variant-numeric: tabular-nums; }
.rr-quota:empty { display: none; }
`;

const SCENE = `
/* the boards are panels of rough timber, bolted at the corners */
.rr-bolt { position: absolute; width: 8px; height: 8px; background: #6d717a; pointer-events: none;
  box-shadow: inset -2px -2px 0 #43464d, inset 2px 2px 0 #9aa0a8, 0 0 0 2px #000; }
.rr-bolt.tl { top: -6px; left: -6px; } .rr-bolt.tr { top: -6px; right: -6px; }
.rr-bolt.bl { bottom: -6px; left: -6px; } .rr-bolt.br { bottom: -6px; right: -6px; }
.rr-wall-shadow { filter: drop-shadow(3px 5px 0 rgba(0,0,0,.5)); }
.rr-soft-shadow { filter: drop-shadow(2px 3px 0 rgba(0,0,0,.38)); }

/* the tunnel: the mouth of a gallery behind the boards, dark rock that gets
   darker in hard steps the deeper it goes, its edge caught by the lamps */
.rr-tunnel { position: absolute; z-index: -1; left: 0; right: 0; top: 0; bottom: calc(-1 * var(--floor-gap));
  pointer-events: none; background-color: #0b0705;
  background-image:
    radial-gradient(ellipse 62% 58% at 50% 56%, rgba(0,0,0,.6) 0 40%, rgba(0,0,0,.4) 40% 62%, rgba(0,0,0,.2) 62% 84%, transparent 84%),
    linear-gradient(rgba(10,6,4,.74), rgba(10,6,4,.74)), var(--rr-art-earth-bits, none), var(--rr-art-earth, none);
  background-size: 100% 100%, 100% 100%, 672px 456px, 480px 336px; background-repeat: no-repeat, no-repeat, repeat, repeat;
  box-shadow: inset 0 0 0 10px rgba(140,96,60,.13), inset 0 0 0 22px rgba(140,96,60,.08), inset 0 0 0 36px rgba(140,96,60,.05),
    0 0 0 3px #0b0705; }
/* the timber set: a post each side, standing in the floor, a knee brace under the cap */
.rr-post { position: absolute; top: 0; bottom: calc(-1 * var(--floor-h) * .4); width: var(--post-w); display: none;
  background: var(--rr-art-post, var(--wood)) 0 0 / 100% 96px repeat-y; image-rendering: pixelated; box-shadow: 4px 0 0 #0008; }
.rr-post.l { right: calc(100% + var(--post-gap)); }
.rr-post.r { left: calc(100% + var(--post-gap)); }
.rr-tunnel .rr-brace { position: absolute; top: clamp(20px, 3.4vh, 34px); width: 36px; height: 36px; display: none; }
.rr-brace.l { left: 0; } .rr-brace.r { right: 0; }
/* a lamp on an iron arm off each post, out over the earth */
.rr-post-lamp { position: absolute; top: clamp(48px, 9vh, 96px); display: none; flex-direction: column; align-items: center; }
.rr-post-lamp.l { right: calc(100% + var(--post-gap) + var(--post-w)); align-items: flex-start; }
.rr-post-lamp.r { left: calc(100% + var(--post-gap) + var(--post-w)); align-items: flex-end; }
.rr-post-lamp .rr-chain { margin-inline: 6px; }
.rr-post-lamp.l .rr-chain, .rr-post-lamp.l .rr-lamp { margin-left: 0; }
.rr-post-lamp.r .rr-chain, .rr-post-lamp.r .rr-lamp { margin-right: 0; }
.rr-post-lamp::before, .rr-lantern-wrap::before {
  content: ""; position: absolute; z-index: -1; pointer-events: none; width: 300px; height: 300px;
  background: var(--lamp-light); animation: rr-flicker 2.4s steps(6) infinite; }
.rr-post-lamp::before { top: 100%; transform: translate(-50%, -62%); }
.rr-post-lamp.l::before { left: 9px; } .rr-post-lamp.r::before { left: calc(100% - 9px); }

.rr-beam { flex: none; position: relative; z-index: 2; height: clamp(22px, 3.6vh, 36px);
  margin-inline: calc(-1 * (var(--post-w) + var(--post-gap) + 6px));
  background: var(--rr-art-beam, var(--wood)) repeat-x; background-size: auto 100%; box-shadow: 0 6px 0 #0007;
  pointer-events: none; }

/* two lamps hang from the cap on chains, either side of the plaque */
.rr-lantern-wrap { position: relative; display: flex; flex-direction: column; align-items: center; pointer-events: none;
  margin-top: calc(-1 * var(--hall-top)); }
.rr-lantern-wrap.l { grid-column: 2; } .rr-lantern-wrap.r { grid-column: 4; }
.rr-lantern-wrap .rr-chain { height: clamp(18px, 4vh, 40px); width: auto; }
.rr-lantern-wrap .rr-lamp { height: clamp(42px, 7.4vh, 72px); width: auto; }
.rr-lantern-wrap::before { left: 50%; top: 68%; transform: translate(-50%, -50%); }
@keyframes rr-flicker { 0%, 100% { opacity: 1; } 30% { opacity: .82; } 55% { opacity: .95; } 80% { opacity: .78; } }
.rr-plaque .rr-plaque-chain { position: absolute; top: -42px; pointer-events: none; }

.rr-hall .rr-prop { position: absolute; z-index: 0; pointer-events: none; width: auto; }
.rr-hall .rr-vein { height: clamp(24px, 4.4vh, 48px); }
.rr-hall .rr-crack { height: clamp(28px, 4.4vh, 44px); opacity: .9; }

/* the earth outside the tunnel, on a screen wide enough to have any */
.rr-side { position: absolute; top: clamp(48px, 9vh, 96px); bottom: calc(-1 * (var(--floor-gap) + var(--floor-h) * .58));
  width: min(240px, calc((100vw - 1280px) / 2 - var(--post-w) - var(--post-gap) - 18px));
  display: none; flex-direction: column; align-items: center;
  gap: clamp(20px, 4vh, 48px); padding-top: clamp(96px, 16vh, 150px); pointer-events: none; }
.rr-side.l { right: calc(100% + var(--post-gap) + var(--post-w) + 12px); }
.rr-side.r { left: calc(100% + var(--post-gap) + var(--post-w) + 12px); }
.rr-side .rr-grow { flex: 1; }
.rr-floor-row { display: flex; align-items: flex-end; justify-content: center; gap: 10px; }
/* drawn at 2x to fit the narrowest side; 3x once there is room (2 x 1.5, still a whole scale) */
.rr-floor-row .rr-standing:has(.rr-sack) { display: none; }
.rr-standing { position: relative; display: inline-block; }
.rr-standing::after { content: ""; position: absolute; z-index: -1; left: 4%; right: -16%; bottom: -6px; height: 13px;
  background: rgba(0,0,0,.6); clip-path: polygon(10% 0, 90% 0, 100% 50%, 90% 100%, 10% 100%, 0 50%); }
.rr-standing:has(.rr-floor-lamp)::before { content: ""; position: absolute; z-index: -1; left: 50%; top: 40%;
  width: 240px; height: 240px; transform: translate(-50%, -50%); pointer-events: none;
  background: var(--lamp-light); animation: rr-flicker 2.6s steps(6) infinite; }

.rr-floor { position: fixed; left: 0; right: 0; bottom: 0; height: var(--floor-h); z-index: 0; pointer-events: none;
  background: var(--rr-art-floor, #120c07) repeat-x; background-size: auto 100%; }
.rr-critters { position: fixed; left: 0; right: 0; bottom: 0; height: var(--floor-h); z-index: 2; pointer-events: none; }
.rr-critters .rr-rat { position: absolute; left: 0; bottom: 10%; height: calc(var(--floor-h) * .5); width: auto;
  transform: translateX(-90px); animation: rr-scurry 24s linear infinite; animation-delay: 3s;
  filter: drop-shadow(2px 2px 0 rgba(0,0,0,.45)); }
@keyframes rr-scurry { 0% { transform: translateX(-90px); } 30%, 100% { transform: translateX(calc(100vw + 90px)); } }
`;

const RESPONSIVE = `
/* the timber posts stand in the margin beside the boards, once there is one */
@media (min-width: 1364px) {
  :root { --post-w: 24px; --post-gap: 2px; }
  .rr-post, .rr-tunnel .rr-brace { display: block; }
}
@media (min-width: 1600px) { .rr-side { display: flex; } .rr-post-lamp { display: flex; } }
@media (min-width: 1760px) {
  .rr-floor-row { zoom: 1.5; }
  .rr-floor-row .rr-standing:has(.rr-sack) { display: inline-block; }
}
@media (max-width: 760px) { .rr-hall .rr-prop { display: none; } }
/* tall enough, or too narrow, for the readings to sit beside the board: they go
   under it, at a fixed share of the height so a run never resizes the track */
@media (max-width: 1180px), (min-height: 860px) {
  .rr-track-body { flex-direction: column; }
  .rr-readings { width: auto; height: 30%; }
}
@media (max-height: 720px) {
  :root { --hall-top: 9px; }
  .rr-field textarea { height: 58px; }
  .rr-field, .rr-tag { margin-bottom: 6px; }
  .rr-board { padding-top: 12px; padding-bottom: 12px; }
  .rr-tag { font-size: 23px; }
  .rr-note { line-height: 1.25; }
}

/* too narrow or too short to fit on one screen: the page scrolls as any other */
@media (max-width: 900px), (max-height: 560px) {
  html, body { height: auto; }
  body { display: block; height: auto; overflow: visible; padding-bottom: 24px; }
  .rr-floor, .rr-critters { display: none; }
  .rr-side { bottom: 0; }
  .rr-tunnel { bottom: 0; }
  #app, .rr-app, .rr-layout, .rr-board-body, .rr-track-body, .rr-viewport { flex: none; }
  .rr-board-body { overflow: visible; }
  .rr-plan-foot .rr-failure { max-height: none; }
  .rr-viewport { container-type: inline-size; min-height: 0; }
  .rr-readings { height: auto; }
  /* the run scrolls the board into view, and the readings then grow under it:
     the browser must not hold on to the form below and scroll the board away */
  .rr-plan-board { overflow-anchor: none; }
}
@supports (width: round(down, 10px, 4px)) {
  @media (max-width: 900px), (max-height: 560px) {
    .rr-grid { --cell: clamp(32px, round(down, 100cqw / var(--w), 16px), 64px); }
  }
}
@media (max-width: 900px) {
  .rr-layout { grid-template-columns: 1fr; }
  /* on a phone the board comes first: it is what the page is for */
  .rr-track-board { order: -1; }
}
@media (max-width: 640px) {
  .rr-hall { grid-template-columns: 1fr; justify-items: center; }
  .rr-plaque { grid-column: 1; padding-inline: var(--s4); }
  .rr-lantern-wrap, .rr-plaque .rr-plaque-chain { display: none; }
  .rr-beam { margin-inline: -16px; }
  /* every pixel of width goes to the board: ten 32-pixel squares fit at 390 */
  .rr-board { padding: var(--s4) var(--s2); }
  .rr-viewport { padding: var(--s1); }
}
@media (prefers-reduced-motion: reduce) {
  .rr-cart, .rr-cart[data-moving], .rr-cart[data-end] { transition: none; animation: none; }
  .rr-cart[data-end="arrived"] { opacity: .4; }
  .rr-cart[data-end="derailed"] { rotate: 35deg; }
  .rr-cart[data-end="wrong_tunnel"] { opacity: .15; }
  .rr-track-board[aria-busy="true"] .rr-status::before, .rr-lantern-wrap::before, .rr-post-lamp::before,
  .rr-standing:has(.rr-floor-lamp)::before { animation: none; }
  .rr-critters .rr-rat { animation: none; transform: none; left: 62%; }
}
`;

export const STYLE = [FONT_FACES, TOKENS, BASE, LAYOUT, FORM, TRACK, SCENE, RESPONSIVE].join('\n');
