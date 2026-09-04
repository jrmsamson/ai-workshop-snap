import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { Effect, Either } from "effect";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SnapError } from "../core/errors.js";
import { compareTrackedPath } from "../core/path.js";
import { decodeUtf8, textToUtf8 } from "../core/text.js";
import { emptyTree, scanWorkingTree, treeFromEntries } from "./tree.js";
import type { Tree } from "../core/types.js";

const created: string[] = [];

const makeRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "snap-tree-test-"));
  created.push(dir);
  return dir;
};

const write = async (root: string, rel: string, content: string): Promise<void> => {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
};

const runEither = <A>(self: Effect.Effect<A, SnapError>): Promise<Either.Either<A, SnapError>> =>
  Effect.runPromise(Effect.either(self));

const unwrap = <A>(outcome: Either.Either<A, SnapError>): A => {
  if (Either.isLeft(outcome)) assert.fail(`unexpected failure: ${outcome.left.detail}`);
  return outcome.right;
};

const failureOf = async (self: Effect.Effect<unknown, SnapError>): Promise<SnapError> => {
  const outcome = await runEither(self);
  if (Either.isRight(outcome)) assert.fail("expected the scan to fail");
  return outcome.left;
};

/** Sorted [path, text-content] snapshot of a tree. */
const snapshot = (tree: Tree): ReadonlyArray<readonly [string, string]> =>
  Array.from(tree.entries())
    .map(([path, bytes]) => [path, decodeUtf8(bytes) as string] as const)
    .sort(([a], [b]) => compareTrackedPath(a, b));

const assertFailure = (error: SnapError, expected: string): void => {
  assert.equal(error.code, 1);
  assert.equal(error.detail, expected);
};

after(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
  }
});

void describe("pure tree helpers", () => {
  void it("emptyTree is empty", () => {
    const tree = emptyTree();
    assert.equal(tree.size, 0);
  });

  void it("treeFromEntries stores bytes and later duplicate paths win", () => {
    const tree = treeFromEntries([
      ["a", textToUtf8("one\n")],
      ["b", textToUtf8("two\n")],
      ["a", textToUtf8("again\n")],
    ]);
    assert.equal(tree.size, 2);
    assert.equal(decodeUtf8(tree.get("a") as Uint8Array), "again\n");
    assert.equal(decodeUtf8(tree.get("b") as Uint8Array), "two\n");
  });
});

void describe("scanWorkingTree", () => {
  void it("tracks regular files recursively and ignores empty directories and .snap", async () => {
    const root = await makeRoot();
    await write(root, "a.txt", "alpha\n");
    await write(root, "sub/b.txt", "beta\n");
    await write(root, ".hidden", "dot\n");
    await write(root, "blank", "");
    await mkdir(join(root, "sub/empty-dir"), { recursive: true });
    await mkdir(join(root, "deep/emptier"), { recursive: true });
    await write(root, ".snap/repository.json", "metadata\n");

    const tree = unwrap(await runEither(scanWorkingTree(root)));
    assert.deepEqual(snapshot(tree), [
      [".hidden", "dot\n"],
      ["a.txt", "alpha\n"],
      ["blank", ""],
      ["sub/b.txt", "beta\n"],
    ]);
  });

  void it("tracks dotfiles and files under a nested .snap directory", async () => {
    const root = await makeRoot();
    await write(root, "inner/.snap/d.txt", "nested-meta\n");
    await write(root, "inner/plain.txt", "plain\n");

    const tree = unwrap(await runEither(scanWorkingTree(root)));
    assert.deepEqual(snapshot(tree), [
      ["inner/.snap/d.txt", "nested-meta\n"],
      ["inner/plain.txt", "plain\n"],
    ]);
  });

  void it("rejects a top-level symlink without following it", async () => {
    const root = await makeRoot();
    await write(root, "ok.txt", "ok\n");
    await symlink("missing", join(root, "link"));

    const error = await failureOf(scanWorkingTree(root));
    assertFailure(error, "unsupported working tree entry: link");
  });

  void it("rejects a symlink nested in a directory with a slash-relative path", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "sub"), { recursive: true });
    await symlink("missing", join(root, "sub/link"));

    const error = await failureOf(scanWorkingTree(root));
    assertFailure(error, "unsupported working tree entry: sub/link");
  });

  void it("reports a missing root as an internal failure", async () => {
    const missing = join(tmpdir(), `snap-tree-does-not-exist-${String(Date.now())}`);
    const error = await failureOf(scanWorkingTree(missing));
    assert.equal(error.code, 2);
  });
});
