/**
 * The stars earned on each level, remembered in this browser.
 *
 * Progress lives only in `localStorage`: there are no accounts and the server
 * keeps nothing per player. Every access goes through a try/catch, as
 * Gridsmith's `storage.ts` does, because a browser in private mode or with site
 * data blocked throws on the first touch rather than returning nothing — and a
 * game that will not open because it could not remember a score is worse than
 * one that forgets it.
 *
 * Nothing secret is ever written here. The visitor's TypeSafe key, when there
 * is one, stays in the key field for the visit and is never stored.
 */

/** The slot the stars are kept in. Namespaced so it cannot collide on a shared origin. */
export const STARS_ITEM = 'railroad-route.stars';

/** The part of `Storage` this module uses, so a test can stand in for it. */
export type ProgressStore = Pick<Storage, 'getItem' | 'setItem'>;

/** Stars by level id, 1 to 3. A level never finished is absent. */
export type Stars = Readonly<Record<string, number>>;

/**
 * The browser's own storage, or `undefined` where there is none to reach.
 *
 * Touched inside the try because merely naming `localStorage` throws in a
 * browser configured to block site data.
 */
export function browserStore(): ProgressStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** A store that remembers nothing, for when the browser will not lend one. */
export function nullStore(): ProgressStore {
  return { getItem: () => null, setItem: () => undefined };
}

/** The stars kept so far. Anything unreadable counts as nothing earned. */
export function readStars(store: ProgressStore): Stars {
  try {
    const parsed: unknown = JSON.parse(store.getItem(STARS_ITEM) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const stars: Record<string, number> = {};
    for (const [level, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3) stars[level] = value;
    }
    return stars;
  } catch {
    return {};
  }
}

/**
 * Keeps `earned` for `levelId` if it beats what was kept, and answers what is
 * kept now. A worse run never takes stars away.
 */
export function recordStars(store: ProgressStore, levelId: string, earned: number): Stars {
  const kept = readStars(store);
  if (earned <= (kept[levelId] ?? 0)) return kept;
  const updated = { ...kept, [levelId]: earned };
  try {
    store.setItem(STARS_ITEM, JSON.stringify(updated));
  } catch {
    // Storage full, or blocked. The stars count for this visit; they will not
    // be here next time.
  }
  return updated;
}
