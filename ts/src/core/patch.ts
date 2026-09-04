import { compareTrackedPath, splitPath } from "./path.js";
import { validateEditScript } from "./diff.js";
import { textToUtf8, tokenizeBytes, isCanonicalTokenSeq } from "./text.js";
import type { Change, Patch, Result, Tree } from "./types.js";
import { err, ok } from "./types.js";

const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/** Encodes arbitrary bytes as canonical padded RFC 4648 base64 (SPEC §4.3). */
export const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * Decodes canonical padded RFC 4648 base64 (SPEC §4.3). Node's `Buffer`
 * decoder is lenient, so canonicality is verified by hand: only standard
 * alphabet characters, padding that is exclusively a trailing run of one or
 * two `=`, a length divisible by four, and an exact encode round-trip (which
 * rejects non-zero pad bits).
 */
export const decodeBase64 = (content: string): Result<Uint8Array> => {
  if (!BASE64_CHARS.test(content) || content.length % 4 !== 0) {
    return err("canonical base64");
  }
  const decoded = Buffer.from(content, "base64");
  if (decoded.toString("base64") !== content) {
    return err("canonical base64");
  }
  return ok(new Uint8Array(decoded));
};

/**
 * Applies one change to the exact base tree (SPEC §4.3). A change that names a
 * path writes its authored bytes; a delete returns `undefined`, meaning the
 * path is absent after the change. `text` and `put` creations require the path
 * to be absent in `base`; `text` edits and `put` replacements require it to be
 * present.
 */
export const applyChange = (change: Change, base: Tree): Result<Uint8Array | undefined> => {
  if (change.type === "delete") {
    if (!base.has(change.path)) {
      return err(`delete of absent path: ${change.path}`);
    }
    return ok(undefined);
  }
  if (change.type === "put") {
    const decoded = decodeBase64(change.content);
    if (decoded._tag === "err") {
      return decoded;
    }
    const existing = base.get(change.path);
    if (existing !== undefined && sameBytes(existing, decoded.value)) {
      return err("no-op change");
    }
    return ok(decoded.value);
  }
  const existing = base.get(change.path);
  const oldTokens = existing === undefined ? [] : tokenizeBytes(existing);
  if (oldTokens === null) {
    return err(`text edit on non-text path: ${change.path}`);
  }
  const validated = validateEditScript(oldTokens, change.edit);
  if (validated._tag === "err") {
    return validated;
  }
  if (!isCanonicalTokenSeq(validated.value.result)) {
    return err(`text edit produces non-canonical tokens: ${change.path}`);
  }
  const result = textToUtf8(validated.value.result.join(""));
  if (existing !== undefined && sameBytes(existing, result)) {
    return err("no-op change");
  }
  return ok(result);
};

/**
 * Materializes a patch's authored result tree from `base` (SPEC §2, §4.2):
 * every change is checked against the exact base tree and the resulting
 * path→bytes map is written into a fresh copy. The present-path set of the
 * result must be prefix-free by path segment.
 */
export const applyPatchToTree = (patch: Patch, base: Tree): Result<Tree> => {
  const tree = new Map<string, Uint8Array>(base);
  for (const change of patch.changes) {
    const result = applyChange(change, base);
    if (result._tag === "err") {
      return result;
    }
    if (result.value === undefined) {
      tree.delete(change.path);
    } else {
      tree.set(change.path, result.value);
    }
  }
  const paths = Array.from(tree.keys()).sort(compareTrackedPath);
  const present = new Set<string>(paths);
  for (const path of paths) {
    const segments = splitPath(path);
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join("/");
      if (present.has(prefix)) {
        return err("tree paths conflict");
      }
    }
  }
  return ok(tree);
};
