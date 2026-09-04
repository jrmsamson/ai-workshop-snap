import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { Effect, Either } from "effect";
import { type SnapError } from "./errors.js";
import * as fsutil from "./fsutil.js";

const run = <A>(effect: Effect.Effect<A, SnapError>): Promise<A> => Effect.runPromise(effect);

const leftError = async (effect: Effect.Effect<unknown, SnapError>): Promise<SnapError> => {
  const either = await Effect.runPromise(Effect.either(effect));
  assert.ok(Either.isLeft(either), "expected the effect to fail");
  return either.left;
};

const tempDir = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "snap-fsutil-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
};

const readText = async (p: string): Promise<string> => readFile(p, "utf8");

const treeOf = (entries: ReadonlyArray<readonly [string, string]>): Map<string, Uint8Array> =>
  new Map(entries.map(([rel, text]) => [rel, Buffer.from(text, "utf8")] as const));

const writeDisk = async (
  root: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<void> => {
  for (const [rel, text] of entries) {
    const target = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
};

const listDisk = async (root: string): Promise<readonly string[]> => {
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const info = await lstat(full);
      if (info.isDirectory()) {
        await walk(full, childRel);
      } else {
        files.push(childRel);
      }
    }
  };
  await walk(root, "");
  return [...files].sort();
};

const isEnoentError = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";

const assertMissing = async (p: string): Promise<void> => {
  await assert.rejects(lstat(p), isEnoentError);
};

void test("readTextFile, readTextFileIfExists, and fileExists distinguish absence from content", async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, "note.txt");

  assert.equal(await run(fsutil.fileExists(target)), false);
  assert.equal(await run(fsutil.readTextFileIfExists(target)), undefined);
  assert.equal((await leftError(fsutil.readTextFile(target))).code, 2);

  await writeFile(target, "hello\n");

  assert.equal(await run(fsutil.fileExists(target)), true);
  assert.equal(await run(fsutil.readTextFileIfExists(target)), "hello\n");
  assert.equal(await run(fsutil.readTextFile(target)), "hello\n");
});

void test("ensureDir creates directories recursively and tolerates an existing directory", async (t) => {
  const root = await tempDir(t);
  const nested = path.join(root, "a", "b", "c");

  await run(fsutil.ensureDir(nested));
  assert.ok((await lstat(nested)).isDirectory());
  await run(fsutil.ensureDir(nested));

  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "x");
  assert.equal((await leftError(fsutil.ensureDir(blocker))).code, 2);
});

void test("removeTree removes files, directories, and symlinks and tolerates absence", async (t) => {
  const root = await tempDir(t);
  const file = path.join(root, "f.txt");
  const dir = path.join(root, "d");
  const nested = path.join(dir, "inner.txt");
  await writeFile(file, "x");
  await writeDisk(root, [["d/inner.txt", "y"]]);
  await symlink(file, path.join(root, "link"));

  const link = path.join(root, "link");
  assert.ok((await lstat(nested)).isFile());
  assert.ok((await lstat(link)).isSymbolicLink());

  await run(fsutil.removeTree(link));
  await assertMissing(link);
  assert.equal(await readText(file), "x");
  await run(fsutil.removeTree(file));
  await assertMissing(file);
  await run(fsutil.removeTree(dir));
  await assertMissing(nested);
  await run(fsutil.removeTree(path.join(root, "does-not-exist")));
});

void test("atomicWriteFile writes bytes with no leftover temp files and overwrites atomically", async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, "data.bin");

  const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
  await run(fsutil.atomicWriteFile(target, bytes));
  assert.deepEqual(await readFile(target), bytes);
  assert.deepEqual((await readdir(root)).sort(), ["data.bin"]);

  await run(fsutil.atomicWriteText(target, "second\n"));
  assert.equal(await readText(target), "second\n");
  assert.deepEqual((await readdir(root)).sort(), ["data.bin"]);
});

void test("atomicWriteFile cleans up its temp file when the rename fails", async (t) => {
  const root = await tempDir(t);
  const dirTarget = path.join(root, "sub");
  await mkdir(dirTarget);

  assert.equal((await leftError(fsutil.atomicWriteFile(dirTarget, Buffer.from("x")))).code, 2);
  assert.deepEqual((await readdir(root)).sort(), ["sub"]);
});

void test("materializeTree creates nested files, overwrites changed bytes, and prunes stale entries", async (t) => {
  const root = await tempDir(t);
  await writeDisk(root, [
    ["keep.txt", "same\n"],
    ["changed.txt", "before\n"],
    ["dir/stale.txt", "stale\n"],
    ["dir/deep/too.txt", "stale\n"],
  ]);
  await mkdir(path.join(root, "empty-a"));

  await run(
    fsutil.materializeTree(
      root,
      treeOf([
        ["keep.txt", "same\n"],
        ["changed.txt", "after\n"],
        ["nested/new.txt", "new\n"],
        ["dir/kept.txt", "kept\n"],
      ]),
    ),
  );

  assert.equal(await readText(path.join(root, "keep.txt")), "same\n");
  assert.equal(await readText(path.join(root, "changed.txt")), "after\n");
  assert.equal(await readText(path.join(root, "nested", "new.txt")), "new\n");
  assert.equal(await readText(path.join(root, "dir", "kept.txt")), "kept\n");
  assert.deepEqual(await listDisk(root), [
    "changed.txt",
    "dir/kept.txt",
    "keep.txt",
    "nested/new.txt",
  ]);
});

void test("materializeTree removes a blocking file when a directory is needed", async (t) => {
  const root = await tempDir(t);
  await writeFile(path.join(root, "a"), "blocking file");

  await run(
    fsutil.materializeTree(
      root,
      treeOf([
        ["a/b.txt", "b\n"],
        ["c.txt", "c\n"],
      ]),
    ),
  );

  assert.equal(await readText(path.join(root, "a", "b.txt")), "b\n");
  assert.equal(await readText(path.join(root, "c.txt")), "c\n");
  assert.deepEqual(await listDisk(root), ["a/b.txt", "c.txt"]);
});

void test("materializeTree removes a blocking directory when a file is needed", async (t) => {
  const root = await tempDir(t);
  await writeDisk(root, [["x/old.txt", "stale"]]);

  await run(
    fsutil.materializeTree(
      root,
      treeOf([
        ["x", "file\n"],
        ["y.txt", "y\n"],
      ]),
    ),
  );

  assert.equal(await readText(path.join(root, "x")), "file\n");
  assert.equal(await readText(path.join(root, "y.txt")), "y\n");
  assert.deepEqual(await listDisk(root), ["x", "y.txt"]);
});

void test("materializeTree preserves the .snap directory while updating the working tree", async (t) => {
  const root = await tempDir(t);
  await writeDisk(root, [
    ["loose.txt", "stale"],
    [".snap/repository.json", "{}"],
  ]);

  await run(fsutil.materializeTree(root, treeOf([["a.txt", "a\n"]])));

  assert.equal(await readText(path.join(root, ".snap", "repository.json")), "{}");
  assert.equal(await readText(path.join(root, "a.txt")), "a\n");
  assert.deepEqual(await listDisk(root), [".snap/repository.json", "a.txt"]);
});

void test("materializeTree with an empty tree removes all working files but keeps .snap", async (t) => {
  const root = await tempDir(t);
  await writeDisk(root, [
    [".snap/repository.json", "{}"],
    ["top.txt", "stale"],
    ["nested/deep/file.txt", "stale"],
  ]);

  await run(fsutil.materializeTree(root, new Map()));

  assert.equal(await readText(path.join(root, ".snap", "repository.json")), "{}");
  assert.deepEqual((await readdir(root)).sort(), [".snap"]);
});

void test("materializeTree creates a missing root directory", async (t) => {
  const base = await tempDir(t);
  const root = path.join(base, "fresh", randomUUID());

  await run(fsutil.materializeTree(root, treeOf([["a.txt", "a\n"]])));

  assert.equal(await readText(path.join(root, "a.txt")), "a\n");
});
