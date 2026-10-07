import { describe, expect, it } from 'vitest';

import type { PublicLevel } from './contract';
import {
  countWords,
  newGame,
  piecesLaid,
  place,
  runRequest,
  squareAt,
  stock,
  tabooHits,
  takeBack,
  turn,
  words,
} from './game';
import type { Edit, Game } from './game';

/**
 * A small level with one of everything: a start, a mine, a tunnel, a rock, a
 * fixed and two rotatable pieces, a switch, and a crate with two kinds in it.
 */
const LEVEL: PublicLevel = {
  id: 'test-level',
  name: 'Test Level',
  order: 1,
  width: 5,
  height: 4,
  cells: [
    { x: 0, y: 1, kind: 'start', rotation: 0, mode: 'fixed' },
    { x: 1, y: 1, kind: 'straight', rotation: 1, mode: 'fixed' },
    { x: 2, y: 1, kind: 'straight', rotation: 0, mode: 'rotatable' },
    { x: 4, y: 1, kind: 'mine', rotation: 0, mode: 'fixed' },
    { x: 3, y: 3, kind: 'tunnel', rotation: 0, mode: 'fixed' },
    { x: 1, y: 2, kind: 'rock', rotation: 0, mode: 'fixed' },
    { x: 2, y: 3, kind: 'curve', rotation: 2, mode: 'rotatable' },
  ],
  switches: [
    {
      id: 'cargo',
      x: 3,
      y: 1,
      entry: 'W',
      question: { type: 'choice', instructions: 'What does the cart carry?', criteria: { coal: 'Coal.', gold: 'Gold.' } },
      exits: { coal: 'S', gold: 'E' },
      threshold: null,
    },
  ],
  inventory: { straight: 2, curve: 1, cross: 0 },
  taboo: ['gold', 'ouro', 'dourad'],
  max_words: 12,
  par_pieces: 1,
};

/** The game an edit produced; fails the test when the edit was refused. */
function done(edit: Edit): Game {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  return edit.game;
}

describe('the board as the level sets it', () => {
  it('reads every square: pieces, the switch, and the empty ones', () => {
    const game = newGame(LEVEL);

    expect(squareAt(game, 0, 1)).toEqual({ kind: 'piece', piece: 'start', rotation: 0, mode: 'fixed' });
    expect(squareAt(game, 2, 3)).toEqual({ kind: 'piece', piece: 'curve', rotation: 2, mode: 'rotatable' });
    expect(squareAt(game, 3, 1)).toMatchObject({ kind: 'switch', switch: { id: 'cargo' } });
    expect(squareAt(game, 0, 0)).toEqual({ kind: 'empty' });
  });

  it('starts with the whole crate and nothing laid', () => {
    const game = newGame(LEVEL);
    expect(stock(game)).toEqual({ straight: 2, curve: 1, cross: 0 });
    expect(piecesLaid(game)).toBe(0);
  });
});

describe('turning', () => {
  it('turns a rotatable piece a quarter clockwise, 0 → 1 → 2 → 3 → 0', () => {
    let game = newGame(LEVEL);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      game = done(turn(game, 2, 1));
      const square = squareAt(game, 2, 1);
      if (square.kind === 'piece') seen.push(square.rotation);
    }
    expect(seen).toEqual([1, 2, 3, 0]);
  });

  it('starts from the turn the level gave the piece', () => {
    const game = done(turn(newGame(LEVEL), 2, 3));
    expect(squareAt(game, 2, 3)).toMatchObject({ rotation: 3 });
  });

  it('refuses a fixed piece, a switch, a rock, an empty square and a square off the board', () => {
    const game = newGame(LEVEL);
    expect(turn(game, 1, 1)).toEqual({ ok: false, reason: 'not_turnable' });
    expect(turn(game, 0, 1)).toEqual({ ok: false, reason: 'not_turnable' });
    expect(turn(game, 3, 1)).toEqual({ ok: false, reason: 'not_turnable' });
    expect(turn(game, 1, 2)).toEqual({ ok: false, reason: 'not_turnable' });
    expect(turn(game, 0, 0)).toEqual({ ok: false, reason: 'not_turnable' });
    expect(turn(game, 5, 0)).toEqual({ ok: false, reason: 'outside' });
    expect(turn(game, -1, 0)).toEqual({ ok: false, reason: 'outside' });
  });

  it('turns a piece the player laid', () => {
    let game = done(place(newGame(LEVEL), 0, 0, 'curve'));
    game = done(turn(game, 0, 0));
    expect(squareAt(game, 0, 0)).toEqual({ kind: 'piece', piece: 'curve', rotation: 1, mode: 'placed' });
  });

  it('leaves the game it was given alone', () => {
    const game = newGame(LEVEL);
    turn(game, 2, 1);
    expect(squareAt(game, 2, 1)).toMatchObject({ rotation: 0 });
  });
});

describe('laying pieces from the crate', () => {
  it('lays a piece on an empty square, at turn 0, and takes it from the crate', () => {
    const game = done(place(newGame(LEVEL), 0, 0, 'straight'));
    expect(squareAt(game, 0, 0)).toEqual({ kind: 'piece', piece: 'straight', rotation: 0, mode: 'placed' });
    expect(stock(game)).toEqual({ straight: 1, curve: 1, cross: 0 });
    expect(piecesLaid(game)).toBe(1);
  });

  it('refuses a square with a piece, a rock or a switch on it', () => {
    const game = newGame(LEVEL);
    expect(place(game, 1, 1, 'straight')).toEqual({ ok: false, reason: 'not_empty' });
    expect(place(game, 1, 2, 'straight')).toEqual({ ok: false, reason: 'not_empty' });
    expect(place(game, 3, 1, 'straight')).toEqual({ ok: false, reason: 'not_empty' });
  });

  it('refuses a square already laid, and a square off the board', () => {
    const game = done(place(newGame(LEVEL), 0, 0, 'straight'));
    expect(place(game, 0, 0, 'straight')).toEqual({ ok: false, reason: 'not_empty' });
    expect(place(game, 0, 4, 'straight')).toEqual({ ok: false, reason: 'outside' });
  });

  it('refuses a kind the crate has run out of, or never had', () => {
    const game = done(place(newGame(LEVEL), 0, 0, 'curve'));
    expect(place(game, 0, 2, 'curve')).toEqual({ ok: false, reason: 'none_left' });
    expect(place(game, 0, 2, 'cross')).toEqual({ ok: false, reason: 'none_left' });
  });

  it('takes a laid piece back to the crate', () => {
    let game = done(place(newGame(LEVEL), 0, 0, 'curve'));
    game = done(takeBack(game, 0, 0));
    expect(squareAt(game, 0, 0)).toEqual({ kind: 'empty' });
    expect(stock(game)).toEqual({ straight: 2, curve: 1, cross: 0 });
    expect(done(place(game, 0, 2, 'curve')).placed.size).toBe(1);
  });

  it('will not take back a piece of the level, or an empty square', () => {
    const game = newGame(LEVEL);
    expect(takeBack(game, 2, 1)).toEqual({ ok: false, reason: 'not_placed' });
    expect(takeBack(game, 0, 0)).toEqual({ ok: false, reason: 'not_placed' });
    expect(takeBack(game, 9, 9)).toEqual({ ok: false, reason: 'outside' });
  });
});

describe('the request that sends the cart', () => {
  it('carries the level, the sentence as typed, and no edits for an untouched board', () => {
    expect(runRequest(newGame(LEVEL), ' a heavy load \n')).toEqual({
      level_id: 'test-level',
      sentence: ' a heavy load \n',
      rotations: [],
      placements: [],
    });
  });

  it('carries only the rotatable cells whose turn changed, as absolute turns', () => {
    let game = newGame(LEVEL);
    game = done(turn(game, 2, 3));
    game = done(turn(game, 2, 1));
    game = done(turn(game, 2, 1));
    expect(runRequest(game, 'x').rotations).toEqual([
      { x: 2, y: 1, rotation: 2 },
      { x: 2, y: 3, rotation: 3 },
    ]);
  });

  it('leaves out a cell turned all the way round', () => {
    let game = newGame(LEVEL);
    for (let i = 0; i < 4; i++) game = done(turn(game, 2, 1));
    expect(runRequest(game, 'x').rotations).toEqual([]);
  });

  it('carries every laid piece with its kind and turn, in reading order', () => {
    let game = newGame(LEVEL);
    game = done(place(game, 4, 3, 'straight'));
    game = done(place(game, 0, 0, 'curve'));
    game = done(turn(game, 0, 0));
    expect(runRequest(game, 'x').placements).toEqual([
      { x: 0, y: 0, kind: 'curve', rotation: 1 },
      { x: 4, y: 3, kind: 'straight', rotation: 0 },
    ]);
  });

  it('forgets a piece that was taken back', () => {
    let game = done(place(newGame(LEVEL), 0, 0, 'curve'));
    game = done(takeBack(game, 0, 0));
    expect(runRequest(game, 'x').placements).toEqual([]);
  });
});

describe('counting words the way the backend does', () => {
  it('counts runs of letters and digits', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('a heavy load of 3 crates')).toBe(6);
  });

  it('splits at apostrophes, hyphens and underscores', () => {
    expect(countWords("don't")).toBe(2);
    expect(countWords('well-known')).toBe(2);
    expect(countWords('snake_case')).toBe(2);
    expect(countWords('...!?')).toBe(0);
  });

  it('keeps an accented word whole, in any script', () => {
    expect(words('Carvão é pesado')).toEqual(['carvao', 'e', 'pesado']);
    expect(countWords('уголь и золото')).toBe(3);
  });
});

describe('spotting forbidden words', () => {
  it('finds a term whatever its case or accents', () => {
    expect(tabooHits(LEVEL, 'GOLD')).toEqual(['gold']);
    expect(tabooHits(LEVEL, 'óuro fino')).toEqual(['ouro']);
    expect(tabooHits(LEVEL, 'um brilho Dourado')).toEqual(['dourad']);
  });

  it('blocks every word that starts with a term, and no word that only contains it', () => {
    expect(tabooHits(LEVEL, 'golden ouros')).toEqual(['gold', 'ouro']);
    expect(tabooHits(LEVEL, 'marigold')).toEqual([]);
  });

  it('lists the terms hit in the level’s order, once each', () => {
    expect(tabooHits(LEVEL, 'dourado gold gold')).toEqual(['gold', 'dourad']);
  });

  it('says nothing about a clean sentence', () => {
    expect(tabooHits(LEVEL, 'heavy yellow metal')).toEqual([]);
  });
});
