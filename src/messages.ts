/**
 * Everything the player reads.
 *
 * The interface is in English, in short sentences, and a failure says what to
 * do next. The note the player writes may be in any language; it is theirs,
 * and it is never put back on screen by anything here. What the switches ask —
 * the instructions and the criteria of each question — comes from the level
 * file and is shown as written there, because that is exactly what Jev reads
 * the note against.
 */

import type { ErrorKind, Outcome, PieceKind, Reading, Side, Switch } from './contract';
import type { Square } from './game';

/** A failure, as a headline and an optional line of detail under it. */
export type Failure = {
  /** What happened and what to do about it. */
  readonly title: string;
  /**
   * The backend's own wording, when it names the rule that was broken. The
   * backend writes it and never puts the note or a key in it (`models.py`,
   * `ErrorResponse`), so it is safe to show as it came.
   */
  readonly detail?: string;
};

/** The fixed labels and sentences of the interface. */
export const UI_TEXT = {
  title: 'Railroad Route',
  tagline: 'Lay the track, write the cart a note, and let Jev throw the switches.',

  planTitle: 'Plan the run',
  levelLabel: 'Level',
  switchesHeading: 'What the switches ask',
  noSwitches: 'No switches on this level: the track alone decides.',
  sentenceLabel: 'The cart’s note',
  sentencePlaceholder: 'One sentence, in any language',
  send: 'Send the cart',
  sending: 'Rolling…',

  keyLabel: 'Your TypeSafe key',
  keyPlaceholder: 'your TypeSafe key',
  keyNote:
    'The key lasts for this visit: it is not kept in the browser and never appears in the page’s address. It goes to this game’s server, which hands it to TypeSafe for your runs and keeps nothing.',

  trackTitleEmpty: 'The track',
  crateLabel: 'Crate',
  takeBack: 'Take back',
  boardLabel: 'Track board',
  boardEmpty: 'The track shows up here once the levels load.',
  readingsHeading: 'What Jev read',
  readingsBefore: 'Send the cart, and what Jev reads at each switch shows up here.',
  noReadings: 'The cart never reached a switch, so Jev read nothing.',

  loadingLevels: 'Loading the levels…',
  ready: 'Turn the marked pieces, lay pieces from the crate, write the note, and send the cart.',
  rolling: 'Jev is reading the note…',
  onTrack: 'The cart is on the track…',

  levelsFailed: 'Could not load the levels. Check your connection and reload the page.',
  emptySentence: 'Write a note for the cart before sending it.',
  networkFailed: 'Could not reach the server. Check your connection and send the cart again.',
  unexpected: 'Something went wrong on the server. Send the cart again.',

  starsRule: (par: number) =>
    `★ the cart reaches the mine · ★★ and every switch is a clear call · ★★★ and you lay no more than ${String(par)} ${par === 1 ? 'piece' : 'pieces'}.`,
} as const;

// --- The level -------------------------------------------------------------------

/** "★★☆", as written on a level that was played. */
export function starMarks(stars: number): string {
  return '★'.repeat(stars) + '☆'.repeat(Math.max(0, 3 - stars));
}

/** The same, said in words for a screen reader. */
export function starWords(stars: number): string {
  return `${String(stars)} of 3 stars`;
}

/** A level in the picker, with the stars earned on it so far. */
export function levelOption(order: number, name: string, stars: number): string {
  return stars > 0 ? `${String(order)}. ${name} ${'★'.repeat(stars)}` : `${String(order)}. ${name}`;
}

/** The note under the picker: the level's own rules. */
export function levelRules(maxWords: number, par: number): string {
  return `Up to ${String(maxWords)} words in the note. Par: ${String(par)} ${par === 1 ? 'piece' : 'pieces'} from the crate.`;
}

export function tabooLine(terms: readonly string[]): string {
  return terms.length === 0 ? 'No forbidden words on this level.' : `Forbidden words: ${terms.join(', ')}.`;
}

/** The word counter under the note. */
export function wordCount(count: number, max: number): string {
  return `${String(count)} / ${String(max)} words`;
}

/** The warning while the note breaks a rule the backend will refuse it for. */
export function noteWarning(count: number, max: number, hits: readonly string[]): string {
  const parts: string[] = [];
  if (count > max) parts.push(`The note is ${String(count - max)} ${count - max === 1 ? 'word' : 'words'} over the limit.`);
  if (hits.length > 0) parts.push(`It uses a forbidden word: ${hits.join(', ')}.`);
  return parts.join(' ');
}

/** The letter a switch is known by, on the board and in the list: A, B, C… */
export function switchLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

const SIDE_WORDS: Readonly<Record<Side, string>> = { N: 'north ↑', E: 'east →', S: 'south ↓', W: 'west ←' };

export function sideWord(side: Side): string {
  return SIDE_WORDS[side];
}

/** One way out of a switch, as the list shows it: the answer, what it means, and where it leads. */
export type ExitLine = { readonly answer: string; readonly meaning: string; readonly side: string };

/**
 * The ways out of `sw`, each with the criterion Jev reads the note against.
 *
 * For a choice the answer is the option's name and the meaning its criterion.
 * For the yes/no gate the meaning is the criterion of that side, and the yes
 * line says how sure Jev has to be. For the scale each level is its own line,
 * in order.
 */
export function exitLines(sw: Switch): ExitLine[] {
  const q = sw.question;
  const lines: ExitLine[] = [];
  const to = (result: string): string => {
    const side = sw.exits[result];
    return side === undefined ? '' : sideWord(side);
  };
  switch (q.type) {
    case 'choice':
      for (const [option, meaning] of Object.entries(q.criteria)) lines.push({ answer: option, meaning, side: to(option) });
      break;
    case 'noul': {
      const bar = sw.threshold === null ? '' : ` (Jev at least ${percent(sw.threshold)} sure)`;
      lines.push({ answer: `yes${bar}`, meaning: q.criteria.true, side: to('yes') });
      lines.push({ answer: 'no', meaning: q.criteria.false, side: to('no') });
      break;
    }
    case 'score':
      q.criteria.forEach((meaning, level) => {
        lines.push({ answer: String(level), meaning, side: to(String(level)) });
      });
      break;
    default: {
      const unreachable: never = q;
      throw new TypeError(`unknown question: ${JSON.stringify(unreachable)}`);
    }
  }
  return lines;
}

/** What kind of switch it is, in a word. */
export function switchKind(sw: Switch): string {
  switch (sw.question.type) {
    case 'choice':
      return 'Points';
    case 'noul':
      return 'Gate';
    case 'score':
      return 'Scale';
    default: {
      const unreachable: never = sw.question;
      throw new TypeError(`unknown question: ${JSON.stringify(unreachable)}`);
    }
  }
}

// --- The board -------------------------------------------------------------------

const PIECE_WORDS: Readonly<Record<PieceKind, string>> = {
  straight: 'Straight track',
  curve: 'Curve',
  cross: 'Crossing',
  start: 'The start',
  mine: 'The mine',
  tunnel: 'A wrong tunnel',
  rock: 'Rock',
};

/** A crate tool's label: the kind and how many are left. */
export function crateLabel(kind: 'straight' | 'curve' | 'cross', left: number): string {
  const name = kind === 'cross' ? 'Crossing' : kind === 'curve' ? 'Curve' : 'Straight';
  return `${name} ×${String(left)}`;
}

/** What a screen reader hears for one square of the board. */
export function describeSquare(square: Square, x: number, y: number, letter?: string): string {
  const where = `row ${String(y + 1)}, column ${String(x + 1)}`;
  switch (square.kind) {
    case 'empty':
      return `Empty, ${where}`;
    case 'switch':
      return `Switch ${letter ?? ''}, ${switchKind(square.switch).toLowerCase()}: ${square.switch.question.instructions} ${where}`;
    case 'piece': {
      const name = PIECE_WORDS[square.piece];
      const how =
        square.mode === 'rotatable' ? ', turns' : square.mode === 'placed' ? ', laid by you, turns' : '';
      return `${name}${how}, ${where}`;
    }
    default: {
      const unreachable: never = square;
      throw new TypeError(`unknown square: ${JSON.stringify(unreachable)}`);
    }
  }
}

// --- A run -------------------------------------------------------------------------

/** How the run ended, said in the status line. */
export function describeOutcome(outcome: Outcome): string {
  switch (outcome) {
    case 'arrived':
      return 'The cart rolled into the mine.';
    case 'derailed':
      return 'The cart came off the track. Check the pieces where it stopped.';
    case 'wrong_tunnel':
      return 'The cart went down the wrong tunnel. Change the note or the track so the switches send it to the mine.';
    case 'loop':
      return 'The cart went round in a loop. Break the loop and send it again.';
    default: {
      const unreachable: never = outcome;
      throw new TypeError(`unknown outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function twoPlaces(value: number): string {
  return value.toFixed(2);
}

/** What one switch read, as the readings panel shows it. */
export type ReadingLine = {
  /** "A · What does the cart carry?" */
  readonly heading: string;
  /** What Jev answered, with its number. */
  readonly verdict: string;
  /** Whether it was a clear call, said either way. */
  readonly margin: string;
};

/**
 * One reading, with the question it answered.
 *
 * The number is the one the decision was made on: the confidence of a choice,
 * the gate's probability against its bar, the score on its scale. `clean` is
 * the backend's verdict on the margin, which is what the second star counts.
 */
export function describeReading(reading: Reading, sw: Switch | undefined, letter: string): ReadingLine {
  const heading = sw === undefined ? `${letter} · ${reading.switch_id}` : `${letter} · ${sw.question.instructions}`;
  let verdict: string;
  switch (reading.type) {
    case 'choice':
      verdict =
        reading.confidence === null
          ? `Chose “${reading.result}”.`
          : `Chose “${reading.result}”, ${percent(reading.confidence)} sure.`;
      break;
    case 'noul': {
      const bar = reading.threshold ?? sw?.threshold ?? null;
      verdict =
        reading.noul === null
          ? `Answered ${reading.result}.`
          : bar === null
            ? `Answered ${reading.result}: ${twoPlaces(reading.noul)}.`
            : `Answered ${reading.result}: ${twoPlaces(reading.noul)} against a bar of ${twoPlaces(bar)}.`;
      break;
    }
    case 'score': {
      const scale = sw?.question.type === 'score' ? sw.question.criteria : undefined;
      const levelName = scale?.[Number(reading.result)];
      const top = scale === undefined ? '' : ` of 0–${String(scale.length - 1)}`;
      const value = reading.score === null ? '' : `${twoPlaces(reading.score)}${top}`;
      verdict = levelName === undefined ? `Weighed ${value}, level ${reading.result}.` : `Weighed ${value}: “${levelName}”.`;
      break;
    }
    default: {
      const unreachable: never = reading.type;
      throw new TypeError(`unknown reading: ${JSON.stringify(unreachable)}`);
    }
  }
  return { heading, verdict, margin: reading.clean ? 'Clear call.' : 'Close call: Jev was near the edge.' };
}

/** Where the answer came from, and what is left of the free runs. */
export function describeQuota(cached: boolean, quota: { remaining: number | null; byok: boolean }): string {
  const source = cached ? 'Jev read this note before, so no run was spent. ' : '';
  if (quota.byok) return `${source}Running on your own key.`;
  if (quota.remaining === null) return source.trim();
  return `${source}Free runs left today: ${String(quota.remaining)}.`;
}

// --- When it goes wrong ----------------------------------------------------------------

const RULE_TITLES: Readonly<Partial<Record<ErrorKind, string>>> = {
  empty_sentence: UI_TEXT.emptySentence,
  too_long: 'The note is too long. Shorten it and send the cart again.',
  too_many_words: 'The note has too many words for this level. Cut it down and send the cart again.',
  taboo: 'The note uses a forbidden word. Say it another way and send the cart again.',
  invalid_board: 'The track has a piece where it cannot go. Pick the level again to reset it.',
  unknown_level: 'The server does not know this level any more. Reload the page.',
};

/** Whether `value` is an error body the backend wrote. */
function errorBody(value: unknown): { error: string; detail: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { error, detail } = value as Record<string, unknown>;
  return typeof error === 'string' && typeof detail === 'string' ? { error, detail } : undefined;
}

/**
 * What to tell the player about a run the server did not answer with 200.
 *
 * The status decides, as the contract defines them (`contract.ts`): 422 is a
 * rule the note or the track broke, and the backend's detail names it; 429 is
 * the free quota spent; 401 is the player's own key refused; 502 is Jev not
 * answering. Only a 422 shows the detail, because only there does it say
 * something the player can act on.
 */
export function describeRunError(status: number, body: unknown): Failure {
  const parsed = errorBody(body);
  switch (status) {
    case 422: {
      const known = parsed !== undefined && Object.hasOwn(RULE_TITLES, parsed.error);
      const title = known ? (RULE_TITLES[parsed.error as ErrorKind] ?? '') : 'The server refused the run. Check the note and the track, and send the cart again.';
      return parsed === undefined || parsed.detail === '' ? { title } : { title, detail: parsed.detail };
    }
    case 429:
      return { title: 'The free runs for today are used up. Paste your own TypeSafe key into the key field to keep playing.' };
    case 401:
      return { title: 'TypeSafe turned the key down. Check the key and send the cart again.' };
    case 502:
      return { title: 'Jev did not answer this time. Wait a moment and send the cart again.' };
    default:
      return { title: UI_TEXT.unexpected, detail: `Status ${String(status)}.` };
  }
}
