import assert from "node:assert/strict";
import { test } from "node:test";

import { replayVersion } from "./replay.js";
import { diffTokens } from "../core/diff.js";
import { tokenize } from "../core/text.js";
import type {
  Change,
  ContributorId,
  Patch,
  Revision,
  TrackedPath,
  Tree,
  Version,
  Result,
} from "../core/types.js";

const unwrap = <A>(result: Result<A>): A => {
  if (result._tag === "err") {
    assert.fail(`unexpected error: ${result.detail}`);
  }
  return result.value;
};

const textChange = (
  path: TrackedPath,
  baseText: string | null,
  newText: string,
): Change & { type: "text" } => {
  const oldTokens = baseText === null ? [] : tokenize(baseText);
  return { type: "text", path, edit: diffTokens(oldTokens, tokenize(newText)) };
};

const del = (path: TrackedPath): Change => ({ type: "delete", path });

const put = (path: TrackedPath, content: string): Change => ({ type: "put", path, content });

const patch = (
  author: ContributorId,
  revision: Revision,
  base: Version,
  changes: readonly Change[],
): Patch => ({ author, revision, base, message: "m", changes });

const treeText = (tree: Tree, path: TrackedPath): string | undefined => {
  const value = tree.get(path);
  return value === undefined ? undefined : Buffer.from(value).toString("utf8");
};

const treeBytes = (tree: Tree, path: TrackedPath): Buffer | undefined => {
  const value = tree.get(path);
  return value === undefined ? undefined : Buffer.from(value);
};

void test("concurrent text merge converges to base\\nB1\\nB2\\nA2\\n", () => {
  const patches = [
    patch("a@x", 1, [], [textChange("story.txt", null, "base\n")]),
    patch("a@x", 2, [["a@x", 1]], [textChange("story.txt", "base\n", "base\nA2\n")]),
    patch("b@x", 1, [["a@x", 1]], [textChange("story.txt", "base\n", "base\nB1\n")]),
    patch(
      "b@x",
      2,
      [
        ["a@x", 1],
        ["b@x", 1],
      ],
      [textChange("story.txt", "base\nB1\n", "base\nB1\nB2\n")],
    ),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["a@x", 2],
      ["b@x", 2],
    ]),
  );
  assert.equal(treeText(result.tree, "story.txt"), "base\nB1\nB2\nA2\n");
  assert.deepEqual(result.warnings, []);
});

void test("replay is idempotent and merge-direction invariant", () => {
  const patches = [
    patch("a@x", 1, [], [textChange("story.txt", null, "base\n")]),
    patch("a@x", 2, [["a@x", 1]], [textChange("story.txt", "base\n", "base\nA2\n")]),
    patch("b@x", 1, [["a@x", 1]], [textChange("story.txt", "base\n", "base\nB1\n")]),
    patch(
      "b@x",
      2,
      [
        ["a@x", 1],
        ["b@x", 1],
      ],
      [textChange("story.txt", "base\nB1\n", "base\nB1\nB2\n")],
    ),
  ];
  const frontier: Version = [
    ["a@x", 2],
    ["b@x", 2],
  ];
  const once = unwrap(replayVersion(patches, frontier));
  const twice = unwrap(replayVersion(patches, frontier));
  assert.equal(treeText(once.tree, "story.txt"), treeText(twice.tree, "story.txt"));
  assert.deepEqual(once.warnings, twice.warnings);
});

void test("namespace-wins: incoming directory vs current file (tests/11 case 1)", () => {
  const patches = [
    patch("alice@x", 1, [], [textChange("a", null, "ancestor\n")]),
    patch("bob@x", 1, [], [textChange("a/b", null, "descendant\n")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["alice@x", 1],
      ["bob@x", 1],
    ]),
  );
  assert.equal(treeText(result.tree, "a"), "ancestor\n");
  assert.equal(result.tree.has("a/b"), false);
  assert.deepEqual(result.warnings, [{ path: "a/b", reason: "namespace-wins" }]);
});

void test("namespace-wins: incoming file vs current directory (tests/11 case 2)", () => {
  const patches = [
    patch("bob@x", 1, [], [textChange("x", null, "ancestor\n")]),
    patch("alice@x", 1, [], [textChange("x/y", null, "descendant\n")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["alice@x", 1],
      ["bob@x", 1],
    ]),
  );
  assert.equal(treeText(result.tree, "x/y"), "descendant\n");
  assert.equal(result.tree.has("x"), false);
  assert.deepEqual(result.warnings, [{ path: "x", reason: "namespace-wins" }]);
});

void test("whole-file conflict rules from tests/10", () => {
  const patches = [
    patch(
      "seed@x",
      1,
      [],
      [
        textChange("delete.txt", null, "base\n"),
        textChange("incompatible.txt", null, "base\n"),
        textChange("later-put.txt", null, "base\n"),
        textChange("identical.txt", null, "base\n"),
      ],
    ),
    patch(
      "alice@x",
      1,
      [["seed@x", 1]],
      [
        textChange("delete.txt", "base\n", "left\n"),
        textChange("incompatible.txt", "base\n", "left text\n"),
        put("later-put.txt", "AAE="),
        textChange("identical.txt", "base\n", "same\n"),
      ],
    ),
    patch(
      "bob@x",
      1,
      [["seed@x", 1]],
      [
        del("delete.txt"),
        put("incompatible.txt", "AP8="),
        textChange("later-put.txt", "base\n", "right text\n"),
        textChange("identical.txt", "base\n", "same\n"),
      ],
    ),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["seed@x", 1],
      ["alice@x", 1],
      ["bob@x", 1],
    ]),
  );
  assert.equal(result.tree.has("delete.txt"), false);
  assert.deepEqual(treeBytes(result.tree, "incompatible.txt"), Buffer.from("AP8=", "base64"));
  assert.deepEqual(treeBytes(result.tree, "later-put.txt"), Buffer.from("AAE=", "base64"));
  assert.equal(treeText(result.tree, "identical.txt"), "same\n");
  assert.deepEqual(result.warnings, [
    { path: "delete.txt", reason: "delete-wins" },
    { path: "incompatible.txt", reason: "put-wins" },
    { path: "later-put.txt", reason: "later-put-wins" },
  ]);
});

void test("later-create-wins for two concurrent creates of one path", () => {
  const patches = [
    patch("alice@x", 1, [], [textChange("f", null, "alice\n")]),
    patch("bob@x", 1, [], [textChange("f", null, "bob\n")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["alice@x", 1],
      ["bob@x", 1],
    ]),
  );
  assert.equal(treeText(result.tree, "f"), "alice\n");
  assert.deepEqual(result.warnings, [{ path: "f", reason: "later-create-wins" }]);
});

void test("identical concurrent creates collapse with no warning", () => {
  const patches = [
    patch("a@x", 1, [], [textChange("f", null, "same\n")]),
    patch("b@x", 1, [], [textChange("f", null, "same\n")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["a@x", 1],
      ["b@x", 1],
    ]),
  );
  assert.equal(treeText(result.tree, "f"), "same\n");
  assert.deepEqual(result.warnings, []);
});

void test("concurrent text merge produces A\\n0\\nB\\n3\\n4\\nTAIL\\n without warnings", () => {
  const patches = [
    patch("seed@x", 1, [], [textChange("f", null, "0\n1\n2\n3\n4\n")]),
    patch("a@x", 1, [["seed@x", 1]], [textChange("f", "0\n1\n2\n3\n4\n", "A\n0\n3\n4\nTAIL\n")]),
    patch("b@x", 1, [["seed@x", 1]], [textChange("f", "0\n1\n2\n3\n4\n", "0\n1\nB\n3\n4\n")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["seed@x", 1],
      ["a@x", 1],
      ["b@x", 1],
    ]),
  );
  assert.equal(treeText(result.tree, "f"), "A\n0\nB\n3\n4\nTAIL\n");
  assert.deepEqual(result.warnings, []);
});

void test("delete-wins: earlier concurrent delete beats an incoming edit", () => {
  const patches = [
    patch("seed@x", 1, [], [textChange("f", null, "base\n")]),
    patch("a@x", 1, [["seed@x", 1]], [del("f")]),
    patch("b@x", 1, [["seed@x", 1]], [textChange("f", "base\n", "edit\n")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["seed@x", 1],
      ["a@x", 1],
      ["b@x", 1],
    ]),
  );
  assert.equal(result.tree.has("f"), false);
  assert.deepEqual(result.warnings, [{ path: "f", reason: "delete-wins" }]);
});

void test("put-wins: binary current content beats an incoming text edit", () => {
  const patches = [
    patch("seed@x", 1, [], [textChange("f", null, "base\n")]),
    patch("a@x", 1, [["seed@x", 1]], [textChange("f", "base\n", "text\n")]),
    patch("b@x", 1, [["seed@x", 1]], [put("f", "AP8=")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["seed@x", 1],
      ["a@x", 1],
      ["b@x", 1],
    ]),
  );
  assert.deepEqual(treeBytes(result.tree, "f"), Buffer.from("AP8=", "base64"));
  assert.deepEqual(result.warnings, [{ path: "f", reason: "put-wins" }]);
});

void test("later-put-wins: incoming put beats an earlier concurrent text edit", () => {
  const patches = [
    patch("seed@x", 1, [], [textChange("f", null, "base\n")]),
    patch("a@x", 1, [["seed@x", 1]], [put("f", "AP8=")]),
    patch("b@x", 1, [["seed@x", 1]], [textChange("f", "base\n", "text\n")]),
  ];
  const result = unwrap(
    replayVersion(patches, [
      ["seed@x", 1],
      ["a@x", 1],
      ["b@x", 1],
    ]),
  );
  assert.deepEqual(treeBytes(result.tree, "f"), Buffer.from("AP8=", "base64"));
  assert.deepEqual(result.warnings, [{ path: "f", reason: "later-put-wins" }]);
});
