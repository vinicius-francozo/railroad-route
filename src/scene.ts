/**
 * Dresses the page: the art the stylesheet asks for, then the room around it.
 *
 * The art comes first and alone. Every track piece, switch and icon goes onto
 * the root element as a `--rr-art-*` custom property holding a data URL, which
 * the stylesheet reads with a fallback; once it is there, `data-art` on the
 * root tells the stylesheet to hide the plain characters the board shows
 * without it.
 *
 * Everything here may give up. If there is no window (the tests run in Node),
 * or the browser will not draw, it returns and the page stays plain and whole:
 * `mountApp` finished the page before this started.
 */

import { drawIcons, drawTrackArt } from './art';
import type { Sprite } from './art';

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
    doc.documentElement.setAttribute('data-art', '');
  } catch {
    // Art that could not be drawn is art left out: the board still shows a
    // character for every piece, and the game plays the same.
  }
}
