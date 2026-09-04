import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";

import { parseJson } from "./json.js";

const describe = (name: string, fn: () => void): void => {
  void nodeDescribe(name, fn);
};

const it = (name: string, fn: () => void): void => {
  void nodeIt(name, fn);
};

const valueOf = (input: string): unknown => {
  const result = parseJson(input);
  assert(result._tag === "ok");
  return result.value;
};

const stringOf = (input: string): string => {
  const value = valueOf(input);
  if (typeof value !== "string") {
    assert.fail("expected a string");
  }
  return value;
};

const numberOf = (input: string): number => {
  const value = valueOf(input);
  if (typeof value !== "number") {
    assert.fail("expected a number");
  }
  return value;
};

const detailOf = (input: string): string => {
  const result = parseJson(input);
  assert(result._tag === "err");
  return result.detail;
};

describe("parseJson: valid documents", () => {
  it("parses an empty object and array", () => {
    assert.deepEqual(valueOf("{}"), {});
    assert.deepEqual(valueOf("[]"), []);
  });

  it("allows ordinary JSON whitespace around tokens", () => {
    assert.deepEqual(valueOf('  { "a" : [ 1 , 2 ] }\n\t'), { a: [1, 2] });
  });

  it("parses a nested mixed document", () => {
    assert.deepEqual(valueOf('{"a":[1,{"b":null},true],"c":"x"}'), {
      a: [1, { b: null }, true],
      c: "x",
    });
  });

  it("parses the repository and contributor-config shapes", () => {
    assert.deepEqual(valueOf('{"format":1,"frontier":[],"patches":[]}'), {
      format: 1,
      frontier: [],
      patches: [],
    });
    assert.deepEqual(valueOf('{"contributor":{"id":"alice@example.com"}}'), {
      contributor: { id: "alice@example.com" },
    });
  });

  it("preserves object-key order", () => {
    assert.deepEqual(valueOf('{"b":1,"a":2}'), { b: 1, a: 2 });
  });

  it("parses top-level primitives", () => {
    assert.equal(valueOf('"hi"'), "hi");
    assert.equal(valueOf("42"), 42);
    assert.equal(valueOf("true"), true);
    assert.equal(valueOf("false"), false);
    assert.equal(valueOf("null"), null);
  });
});

describe("parseJson: numbers pass through untouched", () => {
  it("parses integers, decimals, exponents, and zero", () => {
    assert.equal(numberOf("0"), 0);
    assert.equal(numberOf("42"), 42);
    assert.equal(numberOf("-1"), -1);
    assert.equal(numberOf("1.5"), 1.5);
    assert.equal(numberOf("1e5"), 100000);
    assert.equal(numberOf("1E+5"), 100000);
    assert.equal(numberOf("2.5e-3"), 0.0025);
  });

  it("keeps negative zero distinct", () => {
    assert(Object.is(numberOf("-0"), -0));
  });

  it("passes integers beyond the safe range through as JS numbers", () => {
    const value = numberOf("9007199254740993");
    assert.equal(value, Number("9007199254740993"));
  });

  it("parses large fractional and exponent numbers", () => {
    assert.equal(numberOf("1e308"), 1e308);
    assert.equal(numberOf("1.7976931348623157e308"), Number.MAX_VALUE);
  });

  it("does not reject an overflowing exponent", () => {
    assert.equal(numberOf("1e999"), Infinity);
  });
});

describe("parseJson: strings, escapes, and unicode", () => {
  it("parses empty and plain strings", () => {
    assert.equal(stringOf('""'), "");
    assert.equal(stringOf('"hello world"'), "hello world");
  });

  it("decodes the short escapes", () => {
    assert.equal(stringOf('"\\"\\\\\\/\\b\\f\\n\\r\\t"'), '"\\/\b\f\n\r\t');
  });

  it("decodes \\uXXXX escapes into code units", () => {
    assert.equal(stringOf('"\\u0041"'), "A");
    assert.equal(stringOf('"\\u00e9"'), "é");
  });

  it("combines surrogate-pair \\u escapes into astral code points", () => {
    assert.equal(stringOf('"\\uD83D\\uDE00"'), "😀");
  });

  it("accepts a lone surrogate escape", () => {
    assert.equal(stringOf('"\\uD800"').charCodeAt(0), 0xd800);
  });

  it("keeps literal unicode and escaped forms equal", () => {
    assert.equal(stringOf('"😀"'), stringOf('"\\uD83D\\uDE00"'));
    assert.equal(stringOf('"café"'), stringOf('"caf\\u00e9"'));
  });
});

describe("parseJson: duplicate object keys are rejected anywhere", () => {
  it("rejects duplicate keys at the top level", () => {
    assert.equal(
      detailOf('{"format":1,"format":1,"frontier":[],"patches":[]}'),
      "duplicate JSON key format",
    );
  });

  it("rejects duplicate keys in a nested object with a dotted path", () => {
    assert.equal(
      detailOf('{"contributor":{"id":"a@x","id":"b@x"}}'),
      "duplicate JSON key contributor.id",
    );
  });

  it("rejects duplicates in deeply nested objects", () => {
    assert.equal(detailOf('{"a":{"b":{"c":1,"c":2}}}'), "duplicate JSON key a.b.c");
  });

  it("rejects duplicates inside array elements", () => {
    assert.equal(detailOf('[{"a":{"k":1,"k":2}}]'), "duplicate JSON key a.k");
  });

  it("rejects a repeated key before considering its value", () => {
    const detail = detailOf('{"a":1,"a":}');
    assert.match(detail, /^duplicate JSON key .+/);
  });

  it("allows the same key in sibling objects", () => {
    assert.deepEqual(valueOf('{"a":{"id":1},"b":{"id":2}}'), { a: { id: 1 }, b: { id: 2 } });
  });
});

describe("parseJson: malformed input is rejected", () => {
  it("rejects empty and whitespace-only input", () => {
    assert.match(detailOf(""), /^invalid JSON/);
    assert.match(detailOf("   \n\t"), /^invalid JSON/);
  });

  it("rejects the sample 'not json' text", () => {
    assert.match(detailOf("not json"), /^invalid JSON/);
  });

  it("rejects unterminated and empty structures", () => {
    for (const input of ["{", "[", '{"a":1', '{"a":1,', "[1,2", '{"a":}', "[1,"]) {
      assert.match(detailOf(input), /^invalid JSON/);
    }
  });

  it("rejects trailing commas", () => {
    assert.match(detailOf('{"a":1,}'), /^invalid JSON/);
    assert.match(detailOf("[1,]"), /^invalid JSON/);
  });

  it("rejects missing separators", () => {
    assert.match(detailOf("[1 2]"), /^invalid JSON/);
    assert.match(detailOf('{"a" 1}'), /^invalid JSON/);
  });

  it("rejects unquoted or single-quoted keys and strings", () => {
    assert.match(detailOf("{a:1}"), /^invalid JSON/);
    assert.match(detailOf("{'a':1}"), /^invalid JSON/);
    assert.match(detailOf("'not json'"), /^invalid JSON/);
  });

  it("rejects malformed strings and escapes", () => {
    assert.match(detailOf('"abc'), /^invalid JSON/);
    assert.match(detailOf('"\\x"'), /^invalid JSON/);
    assert.match(detailOf('"\\u12"'), /^invalid JSON/);
    assert.match(detailOf('"\\uZZZZ"'), /^invalid JSON/);
    assert.match(detailOf('"tab\there"'), /^invalid JSON/);
  });

  it("rejects malformed numbers", () => {
    for (const input of ["01", "1.", ".5", "+1", "-", "1e", "1e+", "1.2.3", "--1"]) {
      assert.match(detailOf(input), /^invalid JSON/);
    }
  });

  it("rejects non-JSON number spellings", () => {
    assert.match(detailOf("Infinity"), /^invalid JSON/);
    assert.match(detailOf("-Infinity"), /^invalid JSON/);
    assert.match(detailOf("NaN"), /^invalid JSON/);
    assert.match(detailOf("0x10"), /^invalid JSON/);
  });

  it("rejects trailing garbage after a top-level value", () => {
    for (const input of ["{} x", "1 2", "true false", '"x"x', "[] []", "[1] ]"]) {
      assert.match(detailOf(input), /^invalid JSON/);
    }
  });

  it("rejects stray structural tokens", () => {
    assert.match(detailOf("}"), /^invalid JSON/);
    assert.match(detailOf("]"), /^invalid JSON/);
    assert.match(detailOf(","), /^invalid JSON/);
  });
});

describe("parseJson: result shape", () => {
  it("returns an ok result carrying the parsed value", () => {
    const result = parseJson('{"format":1}');
    assert(result._tag === "ok");
    assert.deepEqual(result.value, { format: 1 });
  });

  it("returns an err result with a detail for malformed input", () => {
    const result = parseJson("{");
    assert(result._tag === "err");
    assert.match(result.detail, /^invalid JSON/);
  });
});
