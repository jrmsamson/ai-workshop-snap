import { Effect } from "effect";

import type {
  Change,
  ContributorId,
  Patch,
  Repository,
  Result,
  Revision,
  TrackedPath,
  Tree,
  Version,
} from "./types.js";
import { err, ok } from "./types.js";
import { internalError, userError, type SnapError } from "./errors.js";
import { readRepositoryJson } from "./repository.js";
import { compareTrackedPath } from "./path.js";
import { encodeBase64 } from "./patch.js";
import { diffTokens } from "./diff.js";
import { isText, textToUtf8, tokenize } from "./text.js";
import { replayVersion } from "./replay.js";

/** Runs an effect, rethrowing its typed error directly (bypasses FiberFailure wrapping). */
export const runEffect = async <A>(effect: Effect.Effect<A, SnapError>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") {
    throw result.left;
  }
  return result.right;
};

/** Walks from `start` upward looking for a directory containing `.snap/repository.json`. */
export const locateRepositoryRoot = (start: string): Effect.Effect<string | undefined, SnapError> =>
  Effect.tryPromise({
    try: async () => {
      const { stat } = await import("node:fs/promises");
      const path = await import("node:path");
      let dir = path.resolve(start);
      for (;;) {
        try {
          if ((await stat(path.join(dir, ".snap", "repository.json"))).isFile()) {
            return dir;
          }
        } catch {
          // not a repository marker here
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
          return undefined;
        }
        dir = parent;
      }
    },
    catch: (cause) => internalError(`cannot inspect directory: ${String(cause)}`),
  });

export const resolveLocalPath = (spec: string, cwd: string): string =>
  spec.startsWith("/") ? spec : `${cwd}/${spec}`;

export const isRemoteOperand = (spec: string): boolean =>
  spec.startsWith("http://") || spec.startsWith("https://");

/** Loads and validates the repository at a repository root; `not a Snap repository` when absent. */
export const requireRepository = (root: string): Effect.Effect<Repository, SnapError> =>
  Effect.flatMap(readRepositoryJson(root), (repo) =>
    repo === undefined ? Effect.fail(userError("not a Snap repository")) : Effect.succeed(repo),
  );

/** Materializes the tree of the repository's current frontier (validated repos replay cleanly). */
export const replayFrontier = (repo: Repository): Tree => {
  const result = replayVersion(repo.patches, repo.frontier);
  if (result._tag === "err") {
    throw new Error(`internal: replay failed on validated repository: ${result.detail}`);
  }
  return result.value.tree;
};

export const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

export const treesEqual = (a: Tree, b: Tree): boolean => {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    if (!sameBytes(a.get(key), b.get(key))) {
      return false;
    }
  }
  return true;
};

export type TreeEntry = {
  readonly path: TrackedPath;
  readonly oldBytes: Uint8Array | undefined;
  readonly newBytes: Uint8Array | undefined;
};

/** Sorted paths whose presence or bytes differ between the two trees. */
export const treeEntries = (oldTree: Tree, newTree: Tree): readonly TreeEntry[] => {
  const keys = new Set<string>([...oldTree.keys(), ...newTree.keys()]);
  const out: TreeEntry[] = [];
  for (const key of keys) {
    const oldBytes = oldTree.get(key);
    const newBytes = newTree.get(key);
    if (!sameBytes(oldBytes, newBytes)) {
      out.push({ path: key, oldBytes, newBytes });
    }
  }
  out.sort((a, b) => compareTrackedPath(a.path, b.path));
  return out;
};

const decodeText = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

/** The single authored change for one path per §7.5's text/put/delete rule. */
export const changeForEntry = (entry: TreeEntry): Change => {
  const { path, oldBytes, newBytes } = entry;
  if (newBytes === undefined) {
    return { type: "delete", path };
  }
  const oldText = oldBytes === undefined ? true : isText(oldBytes);
  const newText = isText(newBytes);
  if (newText && oldText) {
    const oldTokens = oldBytes === undefined ? [] : tokenize(decodeText(oldBytes));
    const newTokens = tokenize(decodeText(newBytes));
    return { type: "text", path, edit: diffTokens(oldTokens, newTokens) };
  }
  return { type: "put", path, content: encodeBase64(newBytes) };
};

export const changesForTrees = (oldTree: Tree, newTree: Tree): readonly Change[] =>
  treeEntries(oldTree, newTree).map(changeForEntry);

/** Asserts the present-path set is prefix-free; else `tree paths conflict`. */
export const ensurePrefixFree = (tree: Tree): Result<void> => {
  const paths = Array.from(tree.keys()).sort(compareTrackedPath);
  const present = new Set<string>(paths);
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join("/");
      if (present.has(prefix)) {
        return err("tree paths conflict");
      }
    }
  }
  return ok(undefined);
};

export const utf8 = textToUtf8;

export const MAX_REVISION = 9007199254740991;

/** The revision a new patch by `author` would take, or an error on overflow (§3.1). */
export const revisionAfter = (base: Version, author: ContributorId): Result<Revision> => {
  const current = base.find(([id]) => id === author)?.[1] ?? 0;
  if (current >= MAX_REVISION) {
    return err("revision overflow");
  }
  return ok(current + 1);
};

/** The result version a new patch would reach: base with the author's counter incremented. */
export const nextFrontier = (base: Version, author: ContributorId): Version => {
  const entries = new Map<ContributorId, Revision>();
  for (const [id, revision] of base) {
    entries.set(id, revision);
  }
  const current = entries.get(author) ?? 0;
  entries.set(author, current + 1);
  const sorted = Array.from(entries, ([id, revision]) => [id, revision] as const);
  sorted.sort((a, b) => compareTrackedPath(a[0], b[0]));
  return sorted;
};

export const newPatch = (
  base: Version,
  author: ContributorId,
  message: string,
  changes: readonly Change[],
): Patch => {
  const current = base.find(([id]) => id === author)?.[1] ?? 0;
  return { author, revision: current + 1, base, message, changes };
};

/** Repository with `patch` appended, sorted by author then revision, frontier advanced. */
export const withPatch = (repo: Repository, patch: Patch): Repository => ({
  format: 1,
  frontier: nextFrontier(repo.frontier, patch.author),
  patches: [...repo.patches, patch].sort((a, b) => {
    const byAuthor = compareTrackedPath(a.author, b.author);
    return byAuthor !== 0 ? byAuthor : a.revision - b.revision;
  }),
});
