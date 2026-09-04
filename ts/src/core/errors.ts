import { Data } from "effect";

/**
 * The single typed error of the CLI.
 *
 * - `code: 1` — an expected error (bad input, validation, user error). Rendered
 *   as one plain line `snap: <detail>` on stderr.
 * - `code: 2` — an unexpected internal failure.
 *
 * Detail strings are produced at the failure site (no shared catalog file);
 * byte-exact strings are documented in PLAN.md and enforced by the acceptance
 * suite.
 */
export class SnapError extends Data.TaggedError("SnapError")<{
  readonly detail: string;
  readonly code: 1 | 2;
}> {}

export const userError = (detail: string): SnapError => new SnapError({ detail, code: 1 });

export const internalError = (detail: string): SnapError => new SnapError({ detail, code: 2 });
