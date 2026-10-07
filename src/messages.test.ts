import { describe, expect, it } from 'vitest';

import type { Reading, Switch } from './contract';
import {
  describeOutcome,
  describeQuota,
  describeReading,
  describeRunError,
  describeSquare,
  exitLines,
  levelOption,
  noteWarning,
  starMarks,
  switchLetter,
} from './messages';

const SCALE: Switch = {
  id: 'urgency',
  x: 2,
  y: 2,
  entry: 'N',
  question: { type: 'score', instructions: 'How urgent is the delivery?', criteria: ['calm', 'normal', 'rush'] },
  exits: { '0': 'W', '1': 'E', '2': 'S' },
  threshold: null,
};

const reading = (over: Partial<Reading>): Reading => ({
  switch_id: 'urgency',
  type: 'score',
  result: '2',
  confidence: 0.8,
  noul: null,
  threshold: null,
  score: 1.82,
  margin: 0.32,
  clean: true,
  ...over,
});

describe('the switches, as the player reads them', () => {
  it('lists every level of a scale, in order, with where it leads', () => {
    expect(exitLines(SCALE)).toEqual([
      { answer: '0', meaning: 'calm', side: 'west ←' },
      { answer: '1', meaning: 'normal', side: 'east →' },
      { answer: '2', meaning: 'rush', side: 'south ↓' },
    ]);
  });

  it('names switches by letter, in the level’s order', () => {
    expect([0, 1, 2].map(switchLetter)).toEqual(['A', 'B', 'C']);
  });

  it('describes a switch square with its question', () => {
    expect(describeSquare({ kind: 'switch', switch: SCALE }, 2, 2, 'C')).toBe(
      'Switch C, scale: How urgent is the delivery? row 3, column 3',
    );
  });
});

describe('what a switch read', () => {
  it('puts a score on its scale, by the level it rounded to', () => {
    expect(describeReading(reading({}), SCALE, 'C')).toEqual({
      heading: 'C · How urgent is the delivery?',
      verdict: 'Weighed 1.82 of 0–2: “rush”.',
      margin: 'Clear call.',
    });
  });

  it('says a close call is one', () => {
    expect(describeReading(reading({ clean: false }), SCALE, 'C').margin).toContain('Close call');
  });

  it('falls back to the switch id when the level does not have it', () => {
    expect(describeReading(reading({}), undefined, '?').heading).toBe('? · urgency');
  });
});

describe('the run, in a sentence', () => {
  it('has a sentence for every ending', () => {
    const endings = (['arrived', 'derailed', 'wrong_tunnel', 'loop'] as const).map(describeOutcome);
    expect(new Set(endings).size).toBe(4);
  });

  it('says where the answer came from and what is left', () => {
    expect(describeQuota(false, { remaining: 3, byok: false })).toBe('Free runs left today: 3.');
    expect(describeQuota(true, { remaining: 3, byok: false })).toBe(
      'Jev read this note before, so no run was spent. Free runs left today: 3.',
    );
    expect(describeQuota(false, { remaining: null, byok: true })).toBe('Running on your own key.');
    expect(describeQuota(false, { remaining: null, byok: false })).toBe('');
  });

  it('writes stars as marks and in the picker', () => {
    expect(starMarks(0)).toBe('☆☆☆');
    expect(starMarks(3)).toBe('★★★');
    expect(levelOption(2, 'The Gate', 0)).toBe('2. The Gate');
    expect(levelOption(2, 'The Gate', 1)).toBe('2. The Gate ★');
  });

  it('warns about both rules at once when both are broken', () => {
    expect(noteWarning(7, 5, ['gold'])).toBe('The note is 2 words over the limit. It uses a forbidden word: gold.');
    expect(noteWarning(5, 5, [])).toBe('');
  });
});

describe('a refused run, in a sentence', () => {
  it('gives every status of the contract its own sentence, and says what to do', () => {
    const titles = [422, 429, 401, 502, 500].map((status) => describeRunError(status, { error: 'taboo', detail: 'x' }).title);
    expect(new Set(titles).size).toBe(5);
    for (const title of titles) expect(title).toMatch(/again|key|Reload|another way/);
  });

  it('tells the player to reload for a refused board, the one way the page has to reset it', () => {
    expect(describeRunError(422, { error: 'invalid_board', detail: 'x' }).title).toContain('Reload the page');
  });

  it('shows the backend’s detail only for a broken rule', () => {
    expect(describeRunError(422, { error: 'taboo', detail: 'forbidden on this level: gold' }).detail).toBe(
      'forbidden on this level: gold',
    );
    expect(describeRunError(401, { error: 'key_rejected', detail: 'nope' }).detail).toBeUndefined();
    expect(describeRunError(502, { error: 'jev_unusable', detail: 'nope' }).detail).toBeUndefined();
  });

  it('reads a body that is not the backend’s as no detail at all', () => {
    expect(describeRunError(422, 'Unprocessable')).toEqual({
      title: 'The server refused the run. Check the note and the track, and send the cart again.',
    });
    expect(describeRunError(422, { error: 'constructor', detail: '' }).title).toContain('The server refused');
    expect(describeRunError(503, undefined).detail).toBe('Status 503.');
  });
});
