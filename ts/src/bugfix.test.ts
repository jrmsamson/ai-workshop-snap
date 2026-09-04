import assert from "node:assert/strict";
import { test } from "node:test";

import { runCommit, runConfig, runInit, runStatus, type Ctx } from "./commands.js";
import { applyChange, applyPatchToTree } from "./patch.js";
import { diffTokens, validateEditScript } from "./diff.js";
import { parseJson } from "./json.js";
import { locateRepositoryRoot, runEffect, revisionAfter, MAX_REVISION } from "./helpers.js";
import { replayVersion } from "./replay.js";
import { validateRepositoryJson } from "./repository.js";
import { textToUtf8, tokenize } from "./text.js";
import type { Change, Patch, Tree, Version } from "./types.js";

const tree = (entries: ReadonlyArray<readonly [string, string]>): Tree =>
  new Map(entries.map(([path, text]) => [path, textToUtf8(text)] as const));

//
// Bug 1 — SPEC §4.3 / §4.4: no-op text changes are not rejected.
//
// applyChange rejects a `put` that reproduces the base bytes ("no-op change"),
// but its text branch never compares the authored result against the base. A
// text edit that leaves the bytes unchanged (retain-only, delete-then-reinsert,
// or an empty script over a present empty file) is therefore accepted, even
// though §4.3 makes any change that does not alter existence or bytes invalid,
// and §4.4 allows an empty script only when creating an empty file.
void test("rejects a retain-only text edit that does not change bytes", () => {
  const change: Change = { type: "text", path: "f", edit: [{ retain: 1 }] };
  const result = applyChange(change, tree([["f", "a\n"]]));
  assert.equal(result._tag, "err");
});

void test("rejects a delete-then-reinsert text edit that does not change bytes", () => {
  const change: Change = {
    type: "text",
    path: "f",
    edit: [{ delete: 1 }, { insert: ["a\n"] }],
  };
  const result = applyChange(change, tree([["f", "a\n"]]));
  assert.equal(result._tag, "err");
});

void test("rejects an empty text edit on a present empty file", () => {
  const change: Change = { type: "text", path: "f", edit: [] };
  const result = applyChange(change, tree([["f", ""]]));
  assert.equal(result._tag, "err");
});

//
// Bug 2 — SPEC §2: the prefix-free check only inspects *adjacent* sorted paths.
//
// applyPatchToTree sorts the present paths and compares each with its
// predecessor, but a whole-segment ancestor need not sort adjacent to its
// descendant: an intermediate sibling (here "a!") sorts between "a" and "a/b".
// A single patch that authors both file "a" and file "a/b" is therefore wrongly
// accepted as prefix-free.
void test("rejects a patch whose authored result is not prefix-free across an intermediate path", () => {
  const patch: Patch = {
    author: "seed@x",
    revision: 1,
    base: [],
    message: "prefix",
    changes: [
      { type: "text", path: "a", edit: [{ insert: ["x\n"] }] },
      { type: "text", path: "a!", edit: [{ insert: ["y\n"] }] },
      { type: "text", path: "a/b", edit: [{ insert: ["z\n"] }] },
    ],
  };
  const result = applyPatchToTree(patch, new Map());
  assert.equal(result._tag, "err", "expected 'a' and 'a/b' to conflict");
});

//
// Bug 3 — SPEC §4.1: patch sorting compares a lexicographic `${author}\0${revision}`
// key, so numeric revision order breaks at 10+ revisions.
//
// validateRepositoryJson orders patches with the string key `${author}\0${revision}`.
// For a single author the revision is compared as a decimal string, so "10" sorts
// before "2". A canonically sorted history with 10 or more revisions by one
// author is therefore wrongly rejected.
void test("accepts a canonically sorted patch list with 10+ revisions by one author", () => {
  const patches: unknown[] = [];
  for (let revision = 1; revision <= 12; revision += 1) {
    patches.push({
      author: "a@x",
      revision,
      base: revision === 1 ? [] : [["a@x", revision - 1]],
      message: `rev ${String(revision)}`,
      changes: [{ type: "put", path: "f", content: Buffer.from([revision]).toString("base64") }],
    });
  }
  const result = validateRepositoryJson({
    format: 1,
    frontier: [["a@x", 12]],
    patches,
  });
  assert.equal(result._tag, "ok", "expected author-then-numeric-revision sort to be accepted");
});

//
// Bug 4 — SPEC §3.1 / §7.5: revision overflow is not guarded.
//
// A contributor already at the maximum safe revision must not be able to author
// another revision (commit/revert would silently produce 9007199254740992).
void test("revisionAfter rejects a commit beyond the maximum safe revision", () => {
  const result = revisionAfter([["a@x", MAX_REVISION]], "a@x");
  assert.equal(result._tag, "err", "expected overflow to be rejected");
});

//
// Bug 5 — SPEC §7.1: init resolves `..` lexically rather than against the filesystem.
//
// `locateRepositoryRoot` walked the raw path string, so `repo/..` was falsely
// classified as inside the repository at `repo`.
void test("locateRepositoryRoot resolves `..` against the filesystem", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "snap-locate-"));
  try {
    await mkdir(path.join(dir, "repo", ".snap"), { recursive: true });
    await writeFile(
      path.join(dir, "repo", ".snap", "repository.json"),
      '{"format":1,"frontier":[],"patches":[]}',
    );
    const result = await runEffect(locateRepositoryRoot(path.join(dir, "repo", "..")));
    assert.equal(
      result,
      undefined,
      "parent directory must not be classified as inside the repository",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

//
// Bug 6 — SPEC §4.1 / §10: parseJson is not total — deeply nested JSON
// overflows the call stack and throws instead of returning a Result.
//
// parseJson documents itself as "total" (it returns an err Result for anything
// it cannot accept rather than throwing). A deeply nested but well-formed JSON
// document (RFC 8259 imposes no depth limit) is instead recursed into until the
// JS call stack overflows, throwing an uncaught RangeError. Reading such a
// `.snap/repository.json` crashes Snap as an unexpected internal failure
// (SPEC §10, exit 2) instead of a clean `snap: <detail>` validation error.
void test("parseJson does not throw on deeply nested input", () => {
  const depth = 10000;
  const input = "[".repeat(depth) + "]".repeat(depth);
  assert.doesNotThrow(() => parseJson(input));
});

//
// Bug 7 — SPEC §7.1: init classifies a non-canonical path to the existing
// repository as "inside" it rather than "already exists".
//
// runInit compares the resolved root returned by locateRepositoryRoot against
// the raw (unresolved) `target` string. A path that names the repository but is
// not canonical — a trailing slash (`repo/`), a `.` segment (`./repo`), or a
// `..` round-trip (`repo/../repo`) — resolves to the same directory yet is not
// string-equal to `target`, so re-initializing reports the wrong error.
void test("init with a non-canonical path to the existing repo reports 'repository already exists'", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "snap-init-"));
  const ctx: Ctx = { cwd: dir, home: undefined, stdoutTerm: false, stderrTerm: false };
  try {
    await runInit(ctx, "repo");
    for (const target of ["repo/", "./repo", "repo/../repo"]) {
      await assert.rejects(
        () => runInit(ctx, target),
        (err: unknown) => (err as { detail?: string }).detail === "repository already exists",
        `re-initializing ${target} must report 'repository already exists', not a nested-repo error`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

//
// Bug 8 — SPEC §2 / §4.4: editing a BOM-prefixed text file drops the BOM on replay.
//
// commit tokenizes text with Buffer#toString("utf8") (helpers.ts `decodeText`),
// which keeps a leading UTF-8 BOM (U+FEFF) inside the first token. Replay and
// patch application, however, tokenize with `tokenizeBytes`/`decodeUtf8`
// (text.ts), whose TextDecoder strips a leading BOM. Editing a BOM-prefixed
// file (a retain + insert) computes the edit against BOM-inclusive tokens but
// applies it against BOM-stripped base tokens, silently discarding the BOM.
// The replayed tree then differs from the working tree: `status` reports a
// spurious modification and merge/revert materialize corrupted (BOM-less)
// content, even though §2 says file contents are arbitrary bytes and §4.4
// treats U+FEFF as ordinary valid UTF-8 text.
//
// Bug 9 — SPEC §4.4: validateEditScript accepts insert tokens that are not
// "text tokens".
//
// §4.4 defines an edit script's `insert` as "one or more nonempty text tokens",
// where a text token never contains an LF before its final byte (a file is
// split immediately after every LF). validateEditScript checks that the insert
// *array* is nonempty but never checks the individual tokens, so an insert of
// `["a\nb"]` (an interior LF) or `[""]` (an empty token) is accepted, and its
// "result" is a non-canonical token sequence.
void test("validateEditScript rejects an insert token containing an interior LF", () => {
  const result = validateEditScript([], [{ insert: ["a\nb"] }]);
  assert.equal(result._tag, "err", "interior-LF insert token must be non-canonical");
});

void test("validateEditScript rejects an empty insert token", () => {
  const result = validateEditScript([], [{ insert: [""] }]);
  assert.equal(result._tag, "err", "empty insert token must be non-canonical");
});

void test("editing a BOM-prefixed text file keeps the BOM in the replayed tree", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "snap-bom-"));
  const base: Ctx = { cwd: dir, home: undefined, stdoutTerm: false, stderrTerm: false };
  try {
    await runInit(base, "repo");
    const repoDir = path.join(dir, "repo");
    const ctx: Ctx = { cwd: repoDir, home: undefined, stdoutTerm: false, stderrTerm: false };
    await runConfig(ctx, false, "a@x");
    await writeFile(path.join(repoDir, "f.txt"), "\uFEFFhello\n");
    await runCommit(ctx, "create");
    await writeFile(path.join(repoDir, "f.txt"), "\uFEFFhello\nworld\n");
    await runCommit(ctx, "edit");
    const status = await runStatus(ctx);
    assert.equal(status.stdout, "version (a@x->2)\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

//
// Bug 10 — SPEC §6.2: namespace resolution treats *unchanged* base paths as
// "made present" and clobbers unrelated concurrent descendants.
//
// integrateOne builds S (the set of paths the incoming patch "makes present")
// from the patch's entire authored result tree instead of just the paths its
// changes actually touch. A patch that only edits `f` — while another
// contributor concurrently turns file `s` into `s/x` — therefore finds the
// untouched `s` still in S (it is present, unchanged, in the patch's authored
// result), treats the concurrent `s/x` as a conflicting descendant, removes it,
// and reinstates the stale `s` file. §6.2 defines S as "the paths that P makes
// present": an inherited, untouched `s` is not made present by this patch, and
// §6.4 requires changes to unrelated paths to commute.
void test("editing an unrelated path does not clobber a concurrent file-to-directory change", () => {
  const textCreate = (path: string, text: string): Change => ({
    type: "text",
    path,
    edit: diffTokens([], tokenize(text)),
  });
  const textEdit = (path: string, from: string, to: string): Change => ({
    type: "text",
    path,
    edit: diffTokens(tokenize(from), tokenize(to)),
  });
  const p = (
    author: string,
    revision: number,
    base: Version,
    changes: readonly Change[],
  ): Patch => ({ author, revision, base, message: "m", changes });

  const seed = p("seed@x", 1, [], [textCreate("s", "S\n"), textCreate("f", "F\n")]);
  const bob = p(
    "bob@x",
    1,
    [["seed@x", 1]],
    [{ type: "delete", path: "s" }, textCreate("s/x", "X\n")],
  );
  const alice = p("alice@x", 1, [["seed@x", 1]], [textEdit("f", "F\n", "F2\n")]);
  const frontier: Version = [
    ["seed@x", 1],
    ["alice@x", 1],
    ["bob@x", 1],
  ];

  const result = replayVersion([seed, bob, alice], frontier);
  if (result._tag === "err") {
    assert.fail(`unexpected replay error: ${result.detail}`);
  }
  const t = result.value.tree;

  const textAt = (path: string): string => {
    const bytes = t.get(path);
    if (bytes === undefined) {
      assert.fail(`expected ${path} to be present`);
    }
    return Buffer.from(bytes).toString("utf8");
  };

  assert.equal(textAt("f"), "F2\n", "alice's edit of f must apply");
  assert.equal(textAt("s/x"), "X\n", "bob's s/x must survive alice's unrelated edit");
  assert.equal(t.has("s"), false, "the stale file s must not be reinstated");
  assert.deepEqual(result.value.warnings, [], "unrelated changes must not emit a warning");
});

//
// Bug 11 — SPEC §2 / §4.5 / §7.5: commit never validates working-tree paths.
//
// scanWorkingTree records files under their raw directory names, and commit
// feeds those paths straight into `changesForTrees` → `newPatch` → `saveRepository`
// without running them through `validateTrackedPath`. A regular file whose name
// contains a backslash (legal on POSIX, forbidden in a tracked path by §2) is
// therefore committed into a patch whose `path` is not a valid tracked path.
// The resulting `.snap/repository.json` fails §4.5 validation on the next read,
// so `status`/`log`/`merge` all report `snap: path is invalid: <path>`: commit
// has silently produced a corrupt repository instead of rejecting the path.
void test("commit rejects a working-tree path containing a backslash", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "snap-backslash-"));
  const base: Ctx = { cwd: dir, home: undefined, stdoutTerm: false, stderrTerm: false };
  try {
    await runInit(base, "repo");
    const repoDir = path.join(dir, "repo");
    const ctx: Ctx = { cwd: repoDir, home: undefined, stdoutTerm: false, stderrTerm: false };
    await runConfig(ctx, false, "a@x");
    await writeFile(path.join(repoDir, "foo\\bar.txt"), "hello\n");
    await assert.rejects(
      () => runCommit(ctx, "backslash path"),
      "commit must reject a working-tree path containing a backslash",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
