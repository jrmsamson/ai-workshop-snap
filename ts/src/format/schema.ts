import { Either, Schema } from "effect";

import type { ContributorConfig, Result } from "../core/types.js";
import { err, ok } from "../core/types.js";

/**
 * Effect Schema documentation of the on-disk formats (SPEC §4.1). These
 * schemas describe the exact typed repository shape; decoding them is only for
 * introspection. Full repository.json validation with byte-exact acceptance
 * messages lives in the sibling repository.ts module (Wave 4), which owns the
 * strict checks these documentation schemas deliberately omit (excess keys,
 * canonical base64, positive safe-integer counts, sorted patches, and so on).
 */

/** A contributor version entry `[id, revision]` as stored in JSON. */
const ContributorEntrySchema = Schema.Tuple(Schema.String, Schema.Int);

/** A version: an array of `[id, revision]` pairs sorted by id (SPEC §3.2). */
export const VersionSchema = Schema.Array(ContributorEntrySchema);

/** One edit operation with exactly one of `retain`, `delete`, or `insert`. */
export const EditOpSchema = Schema.Union(
  Schema.Struct({ retain: Schema.Int }),
  Schema.Struct({ delete: Schema.Int }),
  Schema.Struct({ insert: Schema.Array(Schema.String) }),
);

/** An ordered edit script (SPEC §4.4). */
export const EditScriptSchema = Schema.Array(EditOpSchema);

/** A text change: a token edit against the exact base content. */
const TextChangeSchema = Schema.Struct({
  type: Schema.Literal("text"),
  path: Schema.String,
  edit: EditScriptSchema,
});

/** An atomic create-or-replace change carrying padded RFC 4648 base64. */
const PutChangeSchema = Schema.Struct({
  type: Schema.Literal("put"),
  path: Schema.String,
  content: Schema.String,
});

/** A delete of a path present in the exact base tree. */
const DeleteChangeSchema = Schema.Struct({
  type: Schema.Literal("delete"),
  path: Schema.String,
});

/** The change variants of SPEC §4.3. */
export const ChangeSchema = Schema.Union(TextChangeSchema, PutChangeSchema, DeleteChangeSchema);

/** One patch: author dot, base version, message, and ordered changes. */
export const PatchSchema = Schema.Struct({
  author: Schema.String,
  revision: Schema.Int,
  base: VersionSchema,
  message: Schema.String,
  changes: Schema.Array(ChangeSchema),
});

/** The `.snap/repository.json` value: format, frontier, and patch list. */
export const RepositorySchema = Schema.Struct({
  format: Schema.Literal(1),
  frontier: VersionSchema,
  patches: Schema.Array(PatchSchema),
});

/** The `.snap/config.json` contributor block: exactly `{"contributor":{"id":...}}`. */
export const ContributorConfigSchema = Schema.Struct({
  contributor: Schema.Struct({ id: Schema.String }),
});

const decodeConfig = Schema.decodeUnknownEither(ContributorConfigSchema);

/**
 * Shape-only decode of a contributor config (SPEC §3.1 layout). Excess keys
 * are rejected because the documented config has exactly one key. The id
 * spelling is intentionally not validated here; config.ts combines this shape
 * check with contributor.ts to emit `invalid contributor id: ...`.
 */
export const decodeContributorConfig = (value: unknown): Result<ContributorConfig> => {
  const parsed = decodeConfig(value, { onExcessProperty: "error" });
  if (Either.isRight(parsed)) {
    return ok(parsed.right);
  }
  return err("invalid config file");
};
