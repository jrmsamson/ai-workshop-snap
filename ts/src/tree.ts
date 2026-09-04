import { Effect } from "effect";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

import { internalError, userError, type SnapError } from "./errors.js";
import { validateTrackedPath } from "./path.js";
import type { TrackedPath, Tree } from "./types.js";

type Entry = readonly [TrackedPath, Uint8Array];

/** A new empty tree. */
export const emptyTree = (): Tree => new Map<TrackedPath, Uint8Array>();

/** Builds a tree from path→bytes entries. Later duplicate paths win. */
export const treeFromEntries = (entries: Iterable<readonly [TrackedPath, Uint8Array]>): Tree => {
  const tree = new Map<TrackedPath, Uint8Array>();
  for (const [path, bytes] of entries) tree.set(path, bytes);
  return tree;
};

const readDir = (abs: string): Effect.Effect<readonly Dirent[], SnapError> =>
  Effect.tryPromise({
    try: () => readdir(abs, { withFileTypes: true }),
    catch: () => internalError(`cannot read working tree directory: ${abs}`),
  });

const readFileBytes = (abs: string): Effect.Effect<Uint8Array, SnapError> =>
  Effect.tryPromise({
    try: () => readFile(abs),
    catch: () => internalError(`cannot read working tree file: ${abs}`),
  });

const scanDirectory = (abs: string, rel: string): Effect.Effect<readonly Entry[], SnapError> =>
  Effect.flatMap(readDir(abs), (dirents) => walkDirents(abs, rel, dirents, 0, []));

const walkDirents = (
  abs: string,
  rel: string,
  dirents: readonly Dirent[],
  i: number,
  acc: readonly Entry[],
): Effect.Effect<readonly Entry[], SnapError> => {
  if (i >= dirents.length) return Effect.succeed(acc);
  const entry = dirents[i] as Dirent;
  const name = entry.name;
  const childAbs = `${abs}/${name}`;
  const childRel = rel === "" ? name : `${rel}/${name}`;
  if (entry.isDirectory()) {
    if (rel === "" && name === ".snap") return walkDirents(abs, rel, dirents, i + 1, acc);
    return Effect.flatMap(scanDirectory(childAbs, childRel), (sub) =>
      walkDirents(abs, rel, dirents, i + 1, [...acc, ...sub]),
    );
  }
  if (entry.isFile()) {
    return Effect.flatMap(readFileBytes(childAbs), (bytes) =>
      walkDirents(abs, rel, dirents, i + 1, [...acc, [childRel, bytes] as const]),
    );
  }
  return Effect.fail(userError(`unsupported working tree entry: ${childRel}`));
};

/**
 * Scans the working tree at `root`: every regular file below it except the
 * top-level `.snap` directory and its contents, with empty directories ignored
 * (SPEC §2). Symlinks and other non-regular entries are reported as unsupported
 * and never followed. Unexpected OS errors are internal failures.
 */
export const scanWorkingTree = (root: string): Effect.Effect<Tree, SnapError> =>
  Effect.flatMap(scanDirectory(root, ""), (entries) => {
    for (const [path] of entries) {
      const valid = validateTrackedPath(path);
      if (valid._tag === "err") {
        return Effect.fail(userError(valid.detail));
      }
    }
    return Effect.succeed(treeFromEntries(entries));
  });
