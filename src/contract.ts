/**
 * The shapes the page and the Python backend exchange, mirrored by hand from
 * `backend/railroad/models.py`. That file is the source; when the two disagree, it wins and
 * this one is fixed. Geometry, rotations and the meaning of each field are documented there.
 *
 * `GET /api/levels` answers `PublicLevel[]`, in play order.
 * `POST /api/run` takes a `RunRequest` (and an optional `x-typesafe-key` header for a
 * visitor's own key) and answers `RunResponse` with 200, or `ErrorResponse` with
 * 422 (rules, board, unknown level) · 429 (quota) · 401 (key refused) · 502 (Jev failed).
 */

export type Side = 'N' | 'E' | 'S' | 'W';
export type Rotation = 0 | 1 | 2 | 3;
export type PieceKind = 'straight' | 'curve' | 'cross' | 'start' | 'mine' | 'tunnel' | 'rock';
export type PlaceableKind = 'straight' | 'curve' | 'cross';
export type Mode = 'fixed' | 'rotatable';
export type Outcome = 'arrived' | 'derailed' | 'wrong_tunnel' | 'loop';

export type Cell = {
  readonly x: number;
  readonly y: number;
  readonly kind: PieceKind;
  readonly rotation: Rotation;
  readonly mode: Mode;
};

export type ChoiceQuestion = {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
};

export type NoulQuestion = {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
};

export type ScoreQuestion = {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly string[];
};

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export type Switch = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly entry: Side;
  readonly question: Question;
  /** choice: one per criteria key · noul: "yes" | "no" · score: "0", "1", ... */
  readonly exits: Readonly<Record<string, Side>>;
  readonly threshold: number | null;
};

export type Inventory = {
  readonly straight: number;
  readonly curve: number;
  readonly cross: number;
};

/** A level as the page receives it: everything but the reference solution. */
export type PublicLevel = {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly Cell[];
  readonly switches: readonly Switch[];
  readonly inventory: Inventory;
  readonly taboo: readonly string[];
  readonly max_words: number;
  readonly par_pieces: number;
};

export type RotationEdit = { readonly x: number; readonly y: number; readonly rotation: Rotation };

export type Placement = {
  readonly x: number;
  readonly y: number;
  readonly kind: PlaceableKind;
  readonly rotation: Rotation;
};

export type RunRequest = {
  readonly level_id: string;
  readonly sentence: string;
  readonly rotations: readonly RotationEdit[];
  readonly placements: readonly Placement[];
};

export type PathStep = {
  readonly x: number;
  readonly y: number;
  readonly from_side: Side | null;
  readonly to_side: Side | null;
};

export type Reading = {
  readonly switch_id: string;
  readonly type: 'choice' | 'noul' | 'score';
  readonly result: string;
  readonly confidence: number | null;
  readonly noul: number | null;
  readonly threshold: number | null;
  readonly score: number | null;
  readonly margin: number;
  readonly clean: boolean;
};

export type RunResponse = {
  readonly outcome: Outcome;
  readonly path: readonly PathStep[];
  readonly readings: readonly Reading[];
  readonly stars: 0 | 1 | 2 | 3;
  readonly cached: boolean;
  readonly quota: { readonly remaining: number | null; readonly byok: boolean };
};

export type ErrorKind =
  | 'unknown_level'
  | 'empty_sentence'
  | 'too_long'
  | 'too_many_words'
  | 'taboo'
  | 'invalid_board'
  | 'quota_exhausted'
  | 'key_rejected'
  | 'jev_unavailable'
  | 'jev_unusable';

export type ErrorResponse = { readonly error: ErrorKind; readonly detail: string };
