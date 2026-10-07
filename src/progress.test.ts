import { describe, expect, it } from 'vitest';

import { nullStore, readStars, recordStars, STARS_ITEM } from './progress';
import type { ProgressStore } from './progress';

function memoryStore(initial?: string): ProgressStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set(STARS_ITEM, initial);
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

/** A store that throws on every touch, as a browser with site data blocked does. */
const blocked: ProgressStore = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
};

describe('the stars kept in the browser', () => {
  it('starts with nothing earned', () => {
    expect(readStars(memoryStore())).toEqual({});
  });

  it('keeps the stars of a run, by level', () => {
    const store = memoryStore();
    expect(recordStars(store, 'first-switch', 2)).toEqual({ 'first-switch': 2 });
    expect(readStars(store)).toEqual({ 'first-switch': 2 });
  });

  it('keeps the best run, and a worse one takes nothing away', () => {
    const store = memoryStore();
    recordStars(store, 'first-switch', 2);
    recordStars(store, 'first-switch', 1);
    expect(readStars(store)).toEqual({ 'first-switch': 2 });
    recordStars(store, 'first-switch', 3);
    expect(readStars(store)).toEqual({ 'first-switch': 3 });
  });

  it('writes nothing for a run with no stars', () => {
    const store = memoryStore();
    recordStars(store, 'first-switch', 0);
    expect(store.items.has(STARS_ITEM)).toBe(false);
  });

  it('reads anything it cannot make sense of as nothing earned', () => {
    expect(readStars(memoryStore('not json'))).toEqual({});
    expect(readStars(memoryStore('[3]'))).toEqual({});
    expect(readStars(memoryStore('null'))).toEqual({});
    expect(readStars(memoryStore('{"a": 2, "b": 7, "c": "3", "d": 1.5}'))).toEqual({ a: 2 });
  });

  it('works without storage at all, for this visit', () => {
    expect(readStars(blocked)).toEqual({});
    expect(recordStars(blocked, 'first-switch', 2)).toEqual({ 'first-switch': 2 });
    expect(recordStars(nullStore(), 'first-switch', 1)).toEqual({ 'first-switch': 1 });
  });

  it('keeps every level the visit scored when the storage reads back nothing', () => {
    const first = recordStars(blocked, 'first-switch', 2);
    const both = recordStars(blocked, 'the-gate', 1, first);
    expect(both).toEqual({ 'first-switch': 2, 'the-gate': 1 });
    expect(recordStars(blocked, 'first-switch', 1, both)).toEqual(both);
    expect(recordStars(nullStore(), 'the-gate', 3, both)).toEqual({ 'first-switch': 2, 'the-gate': 3 });
  });

  it('takes the best of what the visit knows and what the storage kept', () => {
    const store = memoryStore('{"first-switch": 3, "the-gate": 1}');
    expect(recordStars(store, 'the-gate', 2, { 'first-switch': 1, 'the-scale': 2 })).toEqual({
      'first-switch': 3,
      'the-gate': 2,
      'the-scale': 2,
    });
  });
});
