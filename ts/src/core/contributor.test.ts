import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Result } from "./types.js";
import { validateContributorId } from "./contributor.js";

const expectOk = <A>(result: Result<A>): A => {
  if (result._tag !== "ok") {
    assert.fail(`expected ok, got err: ${result.detail}`);
  }
  return result.value;
};

const expectErr = <A>(result: Result<A>): string => {
  if (result._tag !== "err") {
    assert.fail(`expected err, got ok: ${JSON.stringify(result.value)}`);
  }
  return result.detail;
};

void test("accepts valid contributor ids", () => {
  for (const id of ["old@x", "global@example.com", "local@example.com", "a@b", "x@y.z"]) {
    assert.equal(expectOk(validateContributorId(id)), id);
  }
});

void test("rejects structurally invalid contributor ids", () => {
  const bad = [
    "two@@x",
    "space @x",
    "a,b@x",
    "a(b)@x",
    "a->b@x",
    "not-an-id",
    "bad-id",
    "",
    "@x",
    "x@",
    "a@b@c",
    "a->@x",
  ];
  for (const id of bad) {
    const detail = expectErr(validateContributorId(id));
    assert.equal(detail, `invalid contributor id: ${id}`);
  }
});

void test("rejects non-ASCII and control characters", () => {
  const bad = ["é@x", "a@bé", "a\n@b", "a\t@b", "a@b\x7f", "a\x1f@b"];
  for (const id of bad) {
    expectErr(validateContributorId(id));
  }
});

void test("enforces the 254 byte limit", () => {
  const at254 = `${"a".repeat(127)}@${"b".repeat(126)}`;
  const at255 = `${"a".repeat(128)}@${"b".repeat(126)}`;
  assert.equal(expectOk(validateContributorId(at254)), at254);
  const detail = expectErr(validateContributorId(at255));
  assert.equal(detail, `invalid contributor id: ${at255}`);
});
