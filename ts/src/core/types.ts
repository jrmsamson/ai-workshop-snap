export type ContributorId = string;

export type Revision = number;

export type ContributorRevision = readonly [ContributorId, Revision];

/** A vector clock: sorted (by contributor id) array of [id, revision] pairs. Empty is `[]`. */
export type Version = readonly ContributorRevision[];

export type TrackedPath = string;

/** A path → bytes map. Keys are validated tracked paths. */
export type Tree = ReadonlyMap<TrackedPath, Uint8Array>;

/** A nonempty text token: the canonical token sequence keeps LF on every token except possibly the final one. */
export type TextToken = string;

export type EditOp =
  | { readonly retain: number }
  | { readonly delete: number }
  | { readonly insert: readonly TextToken[] };

export type EditScript = readonly EditOp[];

export type Change =
  | { readonly type: "text"; readonly path: TrackedPath; readonly edit: EditScript }
  | { readonly type: "put"; readonly path: TrackedPath; readonly content: string }
  | { readonly type: "delete"; readonly path: TrackedPath };

export type Patch = {
  readonly author: ContributorId;
  readonly revision: Revision;
  readonly base: Version;
  readonly message: string;
  readonly changes: readonly Change[];
};

export type Repository = {
  readonly format: 1;
  readonly frontier: Version;
  readonly patches: readonly Patch[];
};

export type WarningReason =
  "delete-wins" | "later-create-wins" | "later-put-wins" | "namespace-wins" | "put-wins";

export type Warning = { readonly path: TrackedPath; readonly reason: WarningReason };

/** Local or global contributor configuration: exactly `{"contributor":{"id":<id>}}`. */
export type ContributorConfig = { readonly contributor: { readonly id: ContributorId } };

/** Discriminated result used by pure validators so they stay total (no `throw`). */
export type Ok<A> = { readonly _tag: "ok"; readonly value: A };

export type Err = { readonly _tag: "err"; readonly detail: string };

export type Result<A> = Ok<A> | Err;

export const ok = <A>(value: A): Ok<A> => ({ _tag: "ok", value });

export const err = (detail: string): Err => ({ _tag: "err", detail });
