/**
 * The board the player edits, and the sentence the cart carries: pure logic,
 * no document.
 *
 * Nothing here decides how a run ends. The Python backend is the one source of
 * truth for a run (`backend/railroad`): it checks the sentence and the board
 * again, simulates the cart and answers with the path. This module only keeps
 * the player's edits inside the level's rules, so the page never offers a move
 * the backend would refuse, and it counts words and spots forbidden ones so the
 * page can warn before the cart is sent. The warning is advice; the backend's
 * refusal is the rule.
 */

import type {
  Inventory,
  Mode,
  PieceKind,
  PlaceableKind,
  Placement,
  PublicLevel,
  Rotation,
  RotationEdit,
  RunRequest,
  Switch,
} from './contract';

/** What one square of the board holds right now. */
export type Square =
  | { readonly kind: 'empty' }
  | { readonly kind: 'switch'; readonly switch: Switch }
  | {
      readonly kind: 'piece';
      readonly piece: PieceKind;
      readonly rotation: Rotation;
      /** `placed` is a piece the player laid from the inventory, and may take back. */
      readonly mode: Mode | 'placed';
    };

/** A level and the player's edits to it. Never mutated: every edit returns a new one. */
export type Game = {
  readonly level: PublicLevel;
  /** The current turn of every rotatable cell of the level, by `key`. */
  readonly turns: ReadonlyMap<string, Rotation>;
  /** The pieces the player laid, by `key`. */
  readonly placed: ReadonlyMap<string, Placement>;
};

/** Why an edit was not made. */
export type Refusal = 'outside' | 'not_turnable' | 'not_empty' | 'none_left' | 'not_placed';

export type Edit = { readonly ok: true; readonly game: Game } | { readonly ok: false; readonly reason: Refusal };

export const PLACEABLE: readonly PlaceableKind[] = ['straight', 'curve', 'cross'];

/** The key a square is filed under. */
export function key(x: number, y: number): string {
  return `${String(x)},${String(y)}`;
}

export function newGame(level: PublicLevel): Game {
  const turns = new Map<string, Rotation>();
  for (const cell of level.cells) {
    if (cell.mode === 'rotatable') turns.set(key(cell.x, cell.y), cell.rotation);
  }
  return { level, turns, placed: new Map() };
}

function inside(game: Game, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < game.level.width && y < game.level.height;
}

export function squareAt(game: Game, x: number, y: number): Square {
  const found = game.level.switches.find((s) => s.x === x && s.y === y);
  if (found !== undefined) return { kind: 'switch', switch: found };
  const cell = game.level.cells.find((c) => c.x === x && c.y === y);
  if (cell !== undefined) {
    const rotation = game.turns.get(key(x, y)) ?? cell.rotation;
    return { kind: 'piece', piece: cell.kind, rotation, mode: cell.mode };
  }
  const laid = game.placed.get(key(x, y));
  if (laid !== undefined) return { kind: 'piece', piece: laid.kind, rotation: laid.rotation, mode: 'placed' };
  return { kind: 'empty' };
}

function next(rotation: Rotation): Rotation {
  return ((rotation + 1) % 4) as Rotation;
}

/**
 * Turns the piece at (x, y) a quarter clockwise: 0, 1, 2, 3 and back to 0.
 *
 * Only a rotatable piece of the level or a piece the player laid turns. A fixed
 * piece, a switch and an empty square do not — the backend refuses a turn of
 * anything else, and the switches never turn so that every level asks Jev the
 * same questions.
 */
export function turn(game: Game, x: number, y: number): Edit {
  if (!inside(game, x, y)) return { ok: false, reason: 'outside' };
  const square = squareAt(game, x, y);
  if (square.kind !== 'piece' || square.mode === 'fixed') return { ok: false, reason: 'not_turnable' };
  const k = key(x, y);
  if (square.mode === 'placed') {
    const placed = new Map(game.placed);
    placed.set(k, { x, y, kind: square.piece as PlaceableKind, rotation: next(square.rotation) });
    return { ok: true, game: { ...game, placed } };
  }
  const turns = new Map(game.turns);
  turns.set(k, next(square.rotation));
  return { ok: true, game: { ...game, turns } };
}

/** How many of each piece are still in the crate. */
export function stock(game: Game): Inventory {
  const left = { ...game.level.inventory };
  for (const laid of game.placed.values()) left[laid.kind] -= 1;
  return left;
}

/** Lays a `kind` from the crate on an empty square (no piece, no switch, no rock), at turn 0. */
export function place(game: Game, x: number, y: number, kind: PlaceableKind): Edit {
  if (!inside(game, x, y)) return { ok: false, reason: 'outside' };
  if (squareAt(game, x, y).kind !== 'empty') return { ok: false, reason: 'not_empty' };
  if (stock(game)[kind] <= 0) return { ok: false, reason: 'none_left' };
  const placed = new Map(game.placed);
  placed.set(key(x, y), { x, y, kind, rotation: 0 });
  return { ok: true, game: { ...game, placed } };
}

/** Takes a piece the player laid back to the crate. Pieces of the level stay. */
export function takeBack(game: Game, x: number, y: number): Edit {
  if (!inside(game, x, y)) return { ok: false, reason: 'outside' };
  if (!game.placed.has(key(x, y))) return { ok: false, reason: 'not_placed' };
  const placed = new Map(game.placed);
  placed.delete(key(x, y));
  return { ok: true, game: { ...game, placed } };
}

/** How many pieces the player has laid, which is what the level's par counts. */
export function piecesLaid(game: Game): number {
  return game.placed.size;
}

/**
 * The request that sends this board and `sentence` down the track.
 *
 * `rotations` carries only the rotatable cells whose turn differs from the
 * level's, in reading order. A cell turned all the way round is back where the
 * level put it and is not an edit. The backend applies a rotation edit as an
 * absolute turn, so sending every rotatable cell would mean the same; sending
 * only the changed ones keeps the request to what the player actually did.
 *
 * The sentence goes as it was typed. Trimming it here would make the page and
 * the backend count different characters against the length limit.
 */
export function runRequest(game: Game, sentence: string): RunRequest {
  const byReading = (a: { x: number; y: number }, b: { x: number; y: number }): number => a.y - b.y || a.x - b.x;
  const rotations: RotationEdit[] = game.level.cells
    .filter((cell) => cell.mode === 'rotatable')
    .map((cell) => ({ x: cell.x, y: cell.y, rotation: game.turns.get(key(cell.x, cell.y)) ?? cell.rotation }))
    .filter((edit) => {
      const cell = game.level.cells.find((c) => c.x === edit.x && c.y === edit.y);
      return cell !== undefined && cell.rotation !== edit.rotation;
    })
    .sort(byReading);
  const placements = [...game.placed.values()].sort(byReading);
  return { level_id: game.level.id, sentence, rotations, placements };
}

// --- The sentence ---------------------------------------------------------------
//
// The same rules as the backend's `rules.py`, which is the authority:
//
// - a word is a maximal run of Unicode letters or digits; everything else —
//   spaces, punctuation, apostrophes, hyphens, underscores — separates words,
//   so "don't" is two words and "well-known" is two;
// - for the Taboo, the sentence and the terms are folded alike: case taken out,
//   decomposed (NFKD) and stripped of combining marks, so "Dourado" meets
//   "dourad"; and a term blocks every word that *starts* with it.
//
// One approximation: Python's `casefold` is done here as `toLowerCase`. They
// differ on a handful of letters — `ß` folds to "ss" in Python and stays `ß`
// here — so on those the warning can miss a word the backend then refuses.
// The warning is advice; the refusal is the rule.

/** `text` with case and accents taken out, as the backend folds it. */
export function fold(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

/** The words of `sentence`, folded. */
export function words(sentence: string): string[] {
  return fold(sentence).match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function countWords(sentence: string): number {
  return words(sentence).length;
}

/** The level's forbidden terms that `sentence` uses, in the level's order. */
export function tabooHits(level: PublicLevel, sentence: string): string[] {
  const found = words(sentence);
  return level.taboo.filter((term) => {
    const folded = fold(term);
    return folded !== '' && found.some((word) => word.startsWith(folded));
  });
}
