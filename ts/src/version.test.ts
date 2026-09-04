import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Result, Version } from "./types.js";
import {
  compareCausal,
  emptyVersion,
  formatVersion,
  joinVersions,
  parseVersion,
  sameVersion,
  snapCompare,
  type CausalRelation,
} from "./version.js";

const parse = (text: string): Version => {
  const result: Result<Version> = parseVersion(text);
  if (result._tag !== "ok") {
    assert.fail(`expected ok for ${text}, got err: ${result.detail}`);
  }
  return result.value;
};

const errOf = (text: string): string => {
  const result = parseVersion(text);
  if (result._tag !== "err") {
    assert.fail(`expected err for ${text}, got ok: ${formatVersion(result.value)}`);
  }
  return result.detail;
};

void test("canonical parse and format round-trip", () => {
  const examples = [
    "()",
    "(a@x->1)",
    "(a@x->2,b@x->2)",
    "(jdegoes@example.com->2323,vigoo@example.com->239)",
  ];
  for (const text of examples) {
    assert.equal(formatVersion(parse(text)), text);
  }
  assert.deepEqual(emptyVersion(), []);
  assert.equal(formatVersion(emptyVersion()), "()");
  assert.equal(sameVersion(parse("()"), emptyVersion()), true);
});

void test("accepts the maximum safe revision and boundary forms", () => {
  assert.equal(formatVersion(parse("(a@x->9007199254740991)")), "(a@x->9007199254740991)");
  assert.equal(formatVersion(parse("(a@x->1,b@x->2)")), "(a@x->1,b@x->2)");
});

void test("rejects malformed versions with invalid version detail", () => {
  const bad = [
    "(a@x->01)",
    "(a@x->1,a@x->2)",
    "(a@x->1,a@x->2,b@x->1)",
    "(b@x->1,a@x->1)",
    "(a@x->1, b@x->1)",
    "(a@x->0)",
    "(a@x->-1)",
    "(a@x->9007199254740992)",
    "(a@x->99999999999999999)",
    "(a@x->)",
    "(a@x->1,)",
    "(,a@x->1)",
    "(a@x->1,,b@x->1)",
    "(a@x)",
    "(a@x1)",
    "(a@x->1",
    "a@x->1)",
    "()x",
    "()()",
    "",
    " ",
    "((a@x->1))",
    "(a@@x->1)",
    "(a@x-> 1)",
  ];
  for (const text of bad) {
    assert.ok(errOf(text).startsWith("invalid version"), `expected invalid version for ${text}`);
  }
});

void test("compareCausal covers before after equal concurrent", () => {
  const empty = parse("()");
  const a1 = parse("(a@x->1)");
  const a2 = parse("(a@x->2)");
  const b1 = parse("(b@x->1)");
  const ab1 = parse("(a@x->1,b@x->1)");
  assert.equal(compareCausal(empty, empty), "equal");
  assert.equal(compareCausal(empty, a1), "before");
  assert.equal(compareCausal(a1, empty), "after");
  assert.equal(compareCausal(a1, a2), "before");
  assert.equal(compareCausal(a2, a1), "after");
  assert.equal(compareCausal(a1, b1), "concurrent");
  assert.equal(compareCausal(b1, a1), "concurrent");
  assert.equal(compareCausal(a1, ab1), "before");
  assert.equal(compareCausal(ab1, a1), "after");
  assert.equal(compareCausal(ab1, parse("(a@x->1,b@x->1)")), "equal");
  assert.equal(compareCausal(parse("(a@x->1,b@x->2)"), parse("(a@x->2,b@x->1)")), "concurrent");
});

void test("compareCausal is antisymmetric", () => {
  const versions = [
    parse("()"),
    parse("(a@x->1)"),
    parse("(a@x->2)"),
    parse("(a@x->1,b@x->1)"),
    parse("(a@x->1,b@x->2)"),
    parse("(b@x->1)"),
  ];
  const inverse: Record<string, CausalRelation> = {
    before: "after",
    after: "before",
    equal: "equal",
    concurrent: "concurrent",
  };
  for (const a of versions) {
    for (const b of versions) {
      assert.equal(compareCausal(a, b), inverse[compareCausal(b, a)]);
    }
  }
});

void test("join is componentwise max and canonical", () => {
  const a1 = parse("(a@x->1)");
  const a2 = parse("(a@x->2)");
  const b1 = parse("(b@x->1)");
  const a1b1 = parse("(a@x->1,b@x->1)");
  assert.equal(formatVersion(joinVersions(a1, b1)), "(a@x->1,b@x->1)");
  assert.equal(formatVersion(joinVersions(a1, a1b1)), "(a@x->1,b@x->1)");
  assert.equal(formatVersion(joinVersions(a2, a1b1)), "(a@x->2,b@x->1)");
  assert.equal(formatVersion(joinVersions(parse("()"), a1)), "(a@x->1)");
});

void test("join obeys idempotent commutative associative laws on examples", () => {
  const x = parse("(a@x->1)");
  const y = parse("(b@x->1)");
  const z = parse("(c@x->1)");
  for (const v of [x, y, z, parse("(a@x->2,b@x->1)")]) {
    assert.ok(sameVersion(joinVersions(v, v), v), "idempotent");
  }
  assert.ok(sameVersion(joinVersions(x, y), joinVersions(y, x)), "commutative");
  assert.ok(sameVersion(joinVersions(x, y), parse("(a@x->1,b@x->1)")), "join adds components");
  const left = joinVersions(joinVersions(x, y), z);
  const right = joinVersions(x, joinVersions(y, z));
  assert.ok(sameVersion(left, right), "associative");
  assert.equal(formatVersion(left), "(a@x->1,b@x->1,c@x->1)");
});

void test("snapCompare is a total order consistent with equality", () => {
  const versions = [
    parse("()"),
    parse("(a@x->1)"),
    parse("(a@x->2)"),
    parse("(a@x->1,b@x->1)"),
    parse("(b@x->1)"),
    parse("(b@x->2)"),
    parse("(a@x->2,b@x->1)"),
  ];
  for (const a of versions) {
    for (const b of versions) {
      const ab = snapCompare(a, b);
      const ba = snapCompare(b, a);
      assert.equal(Math.sign(ab) + Math.sign(ba), 0, "antisymmetric");
      assert.equal(ab === 0, sameVersion(a, b), "zero exactly when equal");
    }
  }
  const sorted = [...versions].sort(snapCompare);
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1];
    const current = sorted[i];
    if (before === undefined || current === undefined) {
      assert.fail("unreachable");
    }
    assert.ok(snapCompare(before, current) <= 0, "sorted ascending");
    assert.ok(
      sameVersion(before, current) || snapCompare(before, current) < 0,
      "distinct versions ordered strictly",
    );
  }
});

void test("snapCompare extends causal order", () => {
  const versions = [
    parse("()"),
    parse("(a@x->1)"),
    parse("(a@x->1,b@x->1)"),
    parse("(a@x->2,b@x->2)"),
    parse("(b@x->1)"),
  ];
  for (const a of versions) {
    for (const b of versions) {
      if (compareCausal(a, b) === "before") {
        assert.ok(snapCompare(a, b) < 0, "causal before implies snap before");
      }
    }
  }
});
