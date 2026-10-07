import { describe, expect, it } from 'vitest';

import { BALLAST, exitMarkNames, METER_PAL, meterRows, ORE_MARKS, PAL } from './art';
import type { Reading, Switch } from './contract';
import {
  describeOutcome,
  describeQuota,
  describeReading,
  describeRunError,
  describeSquare,
  exitLines,
  exitMark,
  GLOBAL_TABOO,
  levelOption,
  noteWarning,
  splitTaboo,
  starMarks,
  switchLetter,
  tabooLine,
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
      { answer: '0', meaning: 'calm', side: 'west ←', mark: 'level-0-3' },
      { answer: '1', meaning: 'normal', side: 'east →', mark: 'level-1-3' },
      { answer: '2', meaning: 'rush', side: 'south ↓', mark: 'level-2-3' },
    ]);
  });

  it('names switches by letter, in the level’s order', () => {
    expect([0, 1, 2].map(switchLetter)).toEqual(['A', 'B', 'C']);
  });

  it('describes a switch square with its question', () => {
    expect(describeSquare({ kind: 'switch', switch: SCALE }, 2, 2, 'C')).toBe(
      'Switch C, scale: How urgent is the delivery?, row 3, column 3',
    );
  });
});

describe('the mark at the end of each branch', () => {
  const choice = (options: readonly string[]): Switch => ({
    id: 'cargo',
    x: 1,
    y: 1,
    entry: 'W',
    question: { type: 'choice', instructions: 'What does the cart carry?', criteria: Object.fromEntries(options.map((o) => [o, o])) },
    exits: Object.fromEntries(options.map((o, i) => [o, (['N', 'E', 'S'] as const)[i % 3] ?? 'E'])),
    threshold: null,
  });
  const gate: Switch = {
    id: 'danger',
    x: 1,
    y: 1,
    entry: 'W',
    question: { type: 'noul', instructions: 'Is the cargo dangerous?', criteria: { true: 'yes', false: 'no' } },
    exits: { yes: 'N', no: 'E' },
    threshold: 0.5,
  };
  const scale = (levels: number): Switch => ({ ...SCALE, question: { ...SCALE.question, criteria: Array.from({ length: levels }, (_, i) => `level ${String(i)}`) } as Switch['question'] });

  it('shows a cargo of the game as its ore', () => {
    const sw = choice(['coal', 'gold', 'crystal']);
    expect(['coal', 'gold', 'crystal'].map((o) => exitMark(sw, o))).toEqual(['coal', 'gold', 'crystal']);
  });

  it('gives any other option a pip by its place, so no two share one', () => {
    const sw = choice(['iron', 'gold', 'salt']);
    expect(['iron', 'gold', 'salt'].map((o) => exitMark(sw, o))).toEqual(['pip-0', 'gold', 'pip-2']);
  });

  it('shows the gate’s yes and no', () => {
    expect([exitMark(gate, 'yes'), exitMark(gate, 'no')]).toEqual(['yes', 'no']);
  });

  it('lights a meter up to the level a scale’s exit stands for', () => {
    expect(['0', '1', '2'].map((r) => exitMark(SCALE, r))).toEqual(['level-0-3', 'level-1-3', 'level-2-3']);
    expect(['0', '1'].map((r) => exitMark(scale(2), r))).toEqual(['level-0-2', 'level-1-2']);
  });

  it('draws a meter of up to four levels, and no picture for a longer scale', () => {
    expect(exitMark(scale(4), '3')).toBe('level-3-4');
    expect(exitMark(scale(5), '4')).toBe(undefined);
  });

  it('has no pip for an option past the fourth, when the options are not cargo', () => {
    const sw = choice(['a', 'b', 'c', 'd', 'e']);
    expect(['a', 'e'].map((o) => exitMark(sw, o))).toEqual([undefined, undefined]);
  });

  it('has no picture for an answer the switch does not have', () => {
    expect(exitMark(choice(['coal', 'gold']), 'crystal')).toBe(undefined);
    expect(exitMark(gate, 'maybe')).toBe(undefined);
    expect(exitMark(SCALE, '3')).toBe(undefined);
    expect(exitMark(SCALE, '1.5')).toBe(undefined);
  });

  it('only ever names a mark the art draws', () => {
    const drawn = exitMarkNames();
    const switches = [choice(['coal', 'gold', 'crystal']), choice(['a', 'b', 'c', 'd']), gate, scale(2), scale(3), scale(4)];
    for (const sw of switches) {
      for (const result of Object.keys(sw.exits).concat(sw.question.type === 'score' ? sw.question.criteria.map((_, i) => String(i)) : [])) {
        const mark = exitMark(sw, result);
        expect(mark === undefined || drawn.includes(mark), `${sw.id} ${result} → ${String(mark)}`).toBe(true);
      }
    }
    expect(exitLines(choice(['coal', 'gold'])).map((line) => line.mark)).toEqual(['coal', 'gold']);
  });
});

describe('the exit marks, as they are drawn', () => {
  /** WCAG 2's contrast ratio of two `#rrggbb` colours. */
  const contrast = (a: string, b: string): number => {
    const luminance = (hex: string): number => {
      const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b2 ?? 0);
    };
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };

  it('gives coal a lit edge that stands out from the dark ballast, a graphic’s 3:1 at least', () => {
    const rows = ORE_MARKS['coal'] ?? [];
    // The outermost painted pixel of each row, from the left: the edge the lamp catches.
    const edge = rows.map((row) => row.replace(/^\.+/, '')[0] ?? '.');
    const lit = edge.filter((ch) => ch !== 'k').map((ch) => PAL[ch] ?? '#000000');
    expect(lit.length).toBeGreaterThanOrEqual(3);
    for (const colour of lit) expect(contrast(colour, BALLAST), colour).toBeGreaterThanOrEqual(3);
  });

  for (const levels of [2, 3, 4]) {
    it(`tells the ${String(levels)} levels of a scale apart by colour and by the count of lit bars`, () => {
      const lit = Array.from({ length: levels }, (_, level) => {
        const pixels = meterRows(level, levels).join('').split('').filter((ch) => ch in METER_PAL);
        return { colours: new Set(pixels), bars: pixels.length };
      });
      for (const { colours } of lit) expect(colours.size).toBe(1);
      expect(new Set(lit.map(({ colours }) => [...colours][0])).size).toBe(levels);
      expect(new Set(lit.map(({ bars }) => bars)).size).toBe(levels);
      // Every lit colour reads on the meter's dark face.
      for (const { colours } of lit) expect(contrast(METER_PAL[[...colours][0] ?? ''] ?? '#000000', PAL['x'] ?? '#000000')).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('the forbidden words, as the player reads them', () => {
  it('copies the global list as the map revised it: no "top", the numbers in words and the digits', () => {
    expect(GLOBAL_TABOO).not.toContain('top');
    expect(GLOBAL_TABOO).toEqual(expect.arrayContaining(['true', 'false', 'verdad', 'fals', 'zero', 'two', 'three', 'dois', 'três', 'tres']));
    expect(GLOBAL_TABOO.slice(-10)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('sets the global terms apart from the level’s own', () => {
    expect(splitTaboo(['coal', 'carvão', ...GLOBAL_TABOO])).toEqual({ own: ['coal', 'carvão'], global: [...GLOBAL_TABOO] });
    expect(splitTaboo(GLOBAL_TABOO.map((term) => term.normalize('NFD'))).own).toEqual([]);
  });

  it('keeps a global term that the level lists as its own with the level’s terms', () => {
    const scale = ['rush', 'second', 'wait', ...GLOBAL_TABOO.filter((term) => term !== 'second')];
    expect(splitTaboo(scale)).toEqual({ own: ['rush', 'second', 'wait'], global: GLOBAL_TABOO.filter((term) => term !== 'second') });
  });

  it('shows a list with no global tail in full', () => {
    expect(splitTaboo(['gold', 'ouro'])).toEqual({ own: ['gold', 'ouro'], global: [] });
  });

  it('at worst shows a global term in the visible line when the data and the copy disagree', () => {
    const drifted = ['coal', ...GLOBAL_TABOO.slice(0, 5), 'top', ...GLOBAL_TABOO.slice(5)];
    expect(splitTaboo(drifted)).toEqual({ own: ['coal', ...GLOBAL_TABOO.slice(0, 5), 'top'], global: GLOBAL_TABOO.slice(5) });
  });

  it('does not say a level forbids nothing when it only has the global terms', () => {
    expect(tabooLine([])).not.toContain('No forbidden words');
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
