import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Change, Patch, Tree } from "./types.js";
import { applyChange, applyPatchToTree, decodeBase64, encodeBase64 } from "./patch.js";
import { textToUtf8 } from "./text.js";

const bytes = (s: string): Uint8Array => textToUtf8(s);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
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

const tree = (entries: ReadonlyArray<readonly [string, string]>): Tree =>
  new Map(entries.map(([path, text]) => [path, bytes(text)] as const));

const makePatch = (changes: readonly Change[]): Patch => ({
  author: "a@x",
  revision: 1,
  base: [],
  message: "m",
  changes,
});

const put = (path: string, content: string): Change => ({ type: "put", path, content });

void describe("encodeBase64 and decodeBase64", () => {
  void it("round-trips arbitrary bytes", () => {
    const cases: ReadonlyArray<Uint8Array> = [
      new Uint8Array([]),
      new Uint8Array([0x00]),
      new Uint8Array([0x00, 0xff]),
      bytes("hello\n"),
      bytes(""),
    ];
    for (const input of cases) {
      const decoded = decodeBase64(encodeBase64(input));
      assert.equal(decoded._tag, "ok");
      assert.ok(sameBytes(decoded.value, input), `round trip failed for ${encodeBase64(input)}`);
    }
  });

  void it("decodes canonical padded examples", () => {
    const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
      ["", new Uint8Array([])],
      ["AA==", new Uint8Array([0x00])],
      ["AP8=", new Uint8Array([0x00, 0xff])],
      ["YQ==", bytes("a")],
      ["YWJj", bytes("abc")],
    ];
    for (const [content, expected] of cases) {
      const result = decodeBase64(content);
      assert.equal(result._tag, "ok", `expected ${content} to decode`);
      assert.ok(sameBytes(result.value, expected), `unexpected bytes for ${content}`);
    }
  });

  void it("rejects malformed and non-canonical content", () => {
    const bad: ReadonlyArray<string> = [
      "abc",
      "A",
      "A=",
      "AA=",
      "AA=A",
      "=AAA",
      "A==A",
      "AA===",
      "====",
      "AB==",
      "AE==",
      "ab/c=",
      "AA=AA",
    ];
    for (const content of bad) {
      const result = decodeBase64(content);
      assert.equal(result._tag, "err", `expected ${content} to be rejected`);
      assert.equal(result.detail, "canonical base64");
    }
  });
});

void describe("applyChange presence rules", () => {
  void it("deletes a path present in the base tree", () => {
    const result = applyChange({ type: "delete", path: "f" }, tree([["f", "x"]]));
    assert.equal(result._tag, "ok");
    assert.equal(result.value, undefined);
  });

  void it("rejects deleting an absent path with the pinned message", () => {
    const result = applyChange({ type: "delete", path: "f" }, tree([]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "delete of absent path: f");
  });

  void it("creates a path with a put when absent", () => {
    const result = applyChange(put("f", "YQ=="), tree([]));
    assert.equal(result._tag, "ok");
    assert.ok(result.value !== undefined && sameBytes(result.value, bytes("a")));
  });

  void it("rejects an identical put as a no-op change", () => {
    const result = applyChange(put("f", "YQ=="), tree([["f", "a"]]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "no-op change");
  });

  void it("replaces a path with a put when the bytes differ", () => {
    const result = applyChange(put("f", "Yg=="), tree([["f", "a"]]));
    assert.equal(result._tag, "ok");
    assert.ok(result.value !== undefined && sameBytes(result.value, bytes("b")));
  });

  void it("creates an empty file with an empty put content", () => {
    const result = applyChange(put("f", ""), tree([]));
    assert.equal(result._tag, "ok");
    assert.ok(result.value !== undefined && result.value.length === 0);
  });

  void it("rejects a put with non-canonical base64", () => {
    const result = applyChange(put("f", "abc"), tree([]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "canonical base64");
  });

  void it("creates a text file from pure inserts when absent", () => {
    const change: Change = { type: "text", path: "f", edit: [{ insert: ["hello\n", "world\n"] }] };
    const result = applyChange(change, tree([]));
    assert.equal(result._tag, "ok");
    assert.ok(result.value !== undefined && sameBytes(result.value, bytes("hello\nworld\n")));
  });

  void it("creates an empty text file with an empty script when absent", () => {
    const change: Change = { type: "text", path: "f", edit: [] };
    const result = applyChange(change, tree([]));
    assert.equal(result._tag, "ok");
    assert.ok(result.value !== undefined && result.value.length === 0);
  });

  void it("rejects a create script that is not valid on the empty token list", () => {
    const change: Change = { type: "text", path: "f", edit: [{ retain: 1 }] };
    const result = applyChange(change, tree([]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "edit consumes beyond old content");
  });

  void it("edits present text content", () => {
    const change: Change = { type: "text", path: "f", edit: [{ delete: 1 }, { retain: 1 }] };
    const result = applyChange(change, tree([["f", "one\ntwo\n"]]));
    assert.equal(result._tag, "ok");
    assert.ok(result.value !== undefined && sameBytes(result.value, bytes("two\n")));
  });

  void it("rejects an empty text edit on a present empty file (no-op)", () => {
    const change: Change = { type: "text", path: "f", edit: [] };
    const result = applyChange(change, tree([["f", ""]]));
    assert.equal(result._tag, "err");
  });

  void it("rejects a text edit over a binary path", () => {
    const binary: Tree = new Map([["f", new Uint8Array([0x00, 0xff])]]);
    const change: Change = { type: "text", path: "f", edit: [{ delete: 1 }] };
    const result = applyChange(change, binary);
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "text edit on non-text path: f");
  });

  void it("propagates edit script validation errors", () => {
    const change: Change = {
      type: "text",
      path: "f",
      edit: [{ insert: ["a\n"] }, { insert: ["b\n"] }],
    };
    const result = applyChange(change, tree([]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "adjacent insert");
  });
});

void describe("applyPatchToTree", () => {
  void it("reports prefix conflicts in the authored result tree", () => {
    const patch = makePatch([put("a", "YQ=="), put("a/b", "Yg==")]);
    const result = applyPatchToTree(patch, tree([]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "tree paths conflict");
  });

  void it("reports a conflict between a base path and a created descendant", () => {
    const patch = makePatch([put("a/b", "Yg==")]);
    const result = applyPatchToTree(patch, tree([["a", "x"]]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "tree paths conflict");
  });

  void it("reports a conflict between a base descendant and a created ancestor", () => {
    const patch = makePatch([put("a", "YQ==")]);
    const result = applyPatchToTree(patch, tree([["a/b", "x"]]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "tree paths conflict");
  });

  void it("propagates a change failure", () => {
    const patch = makePatch([{ type: "delete", path: "f" }]);
    const result = applyPatchToTree(patch, tree([]));
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "delete of absent path: f");
  });

  void it("builds the authored tree from base plus each change", () => {
    const patch = makePatch([
      { type: "delete", path: "dir/gone" },
      put("new.bin", encodeBase64(bytes("b"))),
      { type: "text", path: "empty.txt", edit: [] },
      { type: "text", path: "keep.txt", edit: [{ delete: 1 }, { insert: ["y"] }] },
    ]);
    const base = tree([
      ["keep.txt", "x"],
      ["dir/gone", "old"],
    ]);
    const result = applyPatchToTree(patch, base);
    assert.equal(result._tag, "ok");
    const authored = new Map(result.value);
    assert.equal(authored.has("dir/gone"), false);
    assert.ok(sameBytes(authored.get("keep.txt") as Uint8Array, bytes("y")));
    assert.ok(sameBytes(authored.get("new.bin") as Uint8Array, bytes("b")));
    assert.ok(sameBytes(authored.get("empty.txt") as Uint8Array, bytes("")));
  });
});
