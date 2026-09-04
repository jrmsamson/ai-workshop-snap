import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeUtf8,
  isCanonicalTokenSeq,
  isText,
  textToUtf8,
  tokenize,
  tokenizeBytes,
} from "./text.js";

const bytes = (...values: readonly number[]): Uint8Array => Uint8Array.from(values);

void describe("decodeUtf8", () => {
  void it("decodes valid UTF-8", () => {
    assert.equal(decodeUtf8(textToUtf8("héllo\n")), "héllo\n");
    assert.equal(decodeUtf8(bytes(0x61, 0x0d, 0x0a, 0x62)), "a\r\nb");
    assert.equal(decodeUtf8(bytes(0xf0, 0x9f, 0x98, 0x80)), "😀");
  });

  void it("returns null for invalid UTF-8", () => {
    assert.equal(decodeUtf8(bytes(0xff)), null);
    assert.equal(decodeUtf8(bytes(0x61, 0xff, 0x62)), null);
    assert.equal(decodeUtf8(bytes(0xc3)), null);
    assert.equal(decodeUtf8(bytes(0xc0, 0xaf)), null);
    assert.equal(decodeUtf8(bytes(0xed, 0xa0, 0x80)), null);
  });
});

void describe("isText", () => {
  void it("accepts valid UTF-8 without NUL", () => {
    assert.equal(isText(textToUtf8("")), true);
    assert.equal(isText(textToUtf8("a\r\nb")), true);
    assert.equal(isText(textToUtf8("hé\n")), true);
  });

  void it("rejects NUL bytes and invalid UTF-8", () => {
    assert.equal(isText(bytes(0x61, 0x00, 0x62)), false);
    assert.equal(isText(bytes(0x00)), false);
    assert.equal(isText(bytes(0xff)), false);
    assert.equal(isText(bytes(0x61, 0xff, 0x62)), false);
  });
});

void describe("textToUtf8", () => {
  void it("round-trips through decodeUtf8", () => {
    assert.equal(decodeUtf8(textToUtf8("portable é 😀 bytes")), "portable é 😀 bytes");
  });
});

void describe("tokenize", () => {
  void it("splits after every retained LF", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize("hello"), ["hello"]);
    assert.deepEqual(tokenize("a\nb\n"), ["a\n", "b\n"]);
    assert.deepEqual(tokenize("a\n"), ["a\n"]);
    assert.deepEqual(tokenize("\n"), ["\n"]);
    assert.deepEqual(tokenize("\n\n"), ["\n", "\n"]);
    assert.deepEqual(tokenize("a\nb"), ["a\n", "b"]);
  });

  void it("keeps CRLF intact in a token (test 26)", () => {
    assert.deepEqual(tokenize("a\r\nb"), ["a\r\n", "b"]);
  });

  void it("never yields an empty token", () => {
    assert.ok(tokenize("a\n\nb\n").every((t) => t.length > 0));
  });
});

void describe("isCanonicalTokenSeq", () => {
  void it("accepts canonical sequences", () => {
    assert.equal(isCanonicalTokenSeq([]), true);
    assert.equal(isCanonicalTokenSeq(["hello"]), true);
    assert.equal(isCanonicalTokenSeq(["a\n"]), true);
    assert.equal(isCanonicalTokenSeq(["a\n", "b\n"]), true);
    assert.equal(isCanonicalTokenSeq(["a\r\n", "b"]), true);
    assert.equal(isCanonicalTokenSeq(["a\n", "b\n", "c"]), true);
  });

  void it("rejects LF before a token's final byte", () => {
    assert.equal(isCanonicalTokenSeq(["a\nb"]), false);
    assert.equal(isCanonicalTokenSeq(["a\nb\n", "c"]), false);
  });

  void it("requires a non-final token to end in LF", () => {
    assert.equal(isCanonicalTokenSeq(["a", "b\n"]), false);
    assert.equal(isCanonicalTokenSeq(["a\n", "b", "c\n"]), false);
  });

  void it("rejects empty tokens", () => {
    assert.equal(isCanonicalTokenSeq([""]), false);
    assert.equal(isCanonicalTokenSeq(["a\n", ""]), false);
  });
});

void describe("tokenizeBytes", () => {
  void it("tokenizes text bytes and returns null for binary", () => {
    assert.deepEqual(tokenizeBytes(bytes()), []);
    assert.deepEqual(tokenizeBytes(textToUtf8("a\r\nb")), ["a\r\n", "b"]);
    assert.deepEqual(tokenizeBytes(bytes(0x61, 0x00, 0x62)), null);
    assert.deepEqual(tokenizeBytes(bytes(0xff)), null);
  });
});
