import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareTrackedPath,
  isPathPrefixOrEqual,
  isStrictPathPrefix,
  pathSegmentsSharePrefix,
  splitPath,
  validateTrackedPath,
} from "./path.js";
import { err, ok, type Result } from "./types.js";

const expectOk = (result: Result<string>, expected: string): void => {
  assert.deepEqual(result, ok(expected));
};

const expectErr = (result: Result<string>, p: string): void => {
  assert.deepEqual(result, err(`path is invalid: ${p}`));
};

void describe("validateTrackedPath", () => {
  void it("accepts ordinary and unicode paths unchanged", () => {
    for (const p of [
      "a",
      "nested/file",
      "z",
      "a b",
      ".gitignore",
      "a/.snap",
      "é",
      "😀",
      "a b/c",
      "x/y/z.txt",
    ]) {
      expectOk(validateTrackedPath(p), p);
    }
  });

  void it("accepts nested .snap segments (only the first segment is reserved)", () => {
    expectOk(validateTrackedPath("sub/.snap/file"), "sub/.snap/file");
  });

  void it("rejects empty, dot, and dot-dot paths", () => {
    for (const p of ["", ".", "..", "./a", "a/.", "a/../b", "../a", "a/..", "/", "a/"]) {
      expectErr(validateTrackedPath(p), p);
    }
  });

  void it("rejects empty path segments", () => {
    for (const p of ["a//b", "/a", "a//", "//"]) {
      expectErr(validateTrackedPath(p), p);
    }
  });

  void it("rejects backslashes", () => {
    for (const p of ["a\\b", "\\", "a\\/b"]) {
      expectErr(validateTrackedPath(p), p);
    }
  });

  void it("rejects ASCII control characters", () => {
    for (const p of ["a\u0000b", "a\u0001b", "a\tb", "a\nb", "a\u001fb", "a\u007fb"]) {
      expectErr(validateTrackedPath(p), p);
    }
  });

  void it("rejects a first segment equal to .snap", () => {
    for (const p of [".snap", ".snap/secret", ".snap/a/b"]) {
      expectErr(validateTrackedPath(p), p);
    }
  });
});

void describe("compareTrackedPath", () => {
  void it("sorts by unsigned UTF-8 bytes (code points)", () => {
    const paths = ["😀", "z", "nested/file", "é", "a", "A", "ab", "a/b"];
    const sorted = [...paths].sort(compareTrackedPath);
    assert.deepEqual(sorted, ["A", "a", "a/b", "ab", "nested/file", "z", "é", "😀"]);
  });

  void it("reproduces the SPEC path ordering nested/file < z < é < 😀", () => {
    const ordered = ["nested/file", "z", "é", "😀"];
    const shuffled = ["é", "nested/file", "😀", "z"];
    assert.deepEqual([...shuffled].sort(compareTrackedPath), ordered);
    assert.ok(compareTrackedPath("nested/file", "z") < 0);
    assert.ok(compareTrackedPath("z", "é") < 0);
    assert.ok(compareTrackedPath("é", "😀") < 0);
  });

  void it("is reflexive, antisymmetric, and transitive", () => {
    assert.equal(compareTrackedPath("a", "a"), 0);
    assert.equal(compareTrackedPath("é/😀", "é/😀"), 0);
    assert.equal(Math.sign(compareTrackedPath("b", "a")), -Math.sign(compareTrackedPath("a", "b")));
    const [x, y, z] = ["a", "é", "😀"] as const;
    assert.ok(
      compareTrackedPath(x, y) < 0 && compareTrackedPath(y, z) < 0 && compareTrackedPath(x, z) < 0,
    );
  });
});

void describe("splitPath", () => {
  void it("splits on every slash", () => {
    assert.deepEqual(splitPath("a/b/c"), ["a", "b", "c"]);
    assert.deepEqual(splitPath("a"), ["a"]);
  });
});

void describe("prefix predicates", () => {
  void it("isPathPrefixOrEqual compares whole segments", () => {
    assert.equal(isPathPrefixOrEqual("a", "a"), true);
    assert.equal(isPathPrefixOrEqual("a", "a/b"), true);
    assert.equal(isPathPrefixOrEqual("a/b", "a/b/c"), true);
    assert.equal(isPathPrefixOrEqual("a", "ab"), false);
    assert.equal(isPathPrefixOrEqual("a/b", "a"), false);
    assert.equal(isPathPrefixOrEqual("a/b", "a/c"), false);
    assert.equal(isPathPrefixOrEqual("", "a/b"), true);
  });

  void it("isStrictPathPrefix excludes equality", () => {
    assert.equal(isStrictPathPrefix("a", "a"), false);
    assert.equal(isStrictPathPrefix("a", "a/b"), true);
    assert.equal(isStrictPathPrefix("a/b", "a"), false);
    assert.equal(isStrictPathPrefix("", "a"), false);
  });

  void it("pathSegmentsSharePrefix detects namespace collisions", () => {
    assert.equal(pathSegmentsSharePrefix("a", "a"), true);
    assert.equal(pathSegmentsSharePrefix("a", "a/b"), true);
    assert.equal(pathSegmentsSharePrefix("a/b", "a"), true);
    assert.equal(pathSegmentsSharePrefix("a", "ab"), false);
    assert.equal(pathSegmentsSharePrefix("a/b", "a/c"), false);
  });
});
