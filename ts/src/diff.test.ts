import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EditOp, EditScript } from "./types.js";
import { applyEditScript, diffTokens, validateEditScript } from "./diff.js";

const kindOf = (op: EditOp): string =>
  "insert" in op ? "insert" : "retain" in op ? "retain" : "delete";

const hasAdjacentSameKind = (script: EditScript): boolean => {
  for (let i = 1; i < script.length; i += 1) {
    const prev = script[i - 1];
    const cur = script[i];
    if (prev !== undefined && cur !== undefined && kindOf(prev) === kindOf(cur)) {
      return true;
    }
  }
  return false;
};

const roundTrip = (oldTokens: readonly string[], newTokens: readonly string[]): void => {
  const script = diffTokens(oldTokens, newTokens);
  assert.deepEqual(applyEditScript(oldTokens, script), newTokens);
  assert.equal(
    hasAdjacentSameKind(script),
    false,
    "diff output must have no adjacent same-kind ops",
  );
};

void describe("diffTokens goldens", () => {
  void it("matches the repository edit for the repeated-line golden (tests/05)", () => {
    const oldTokens = ["a\n", "b\n", "a\n"];
    const newTokens = ["b\n", "a\n", "a"];
    assert.deepEqual(diffTokens(oldTokens, newTokens), [
      { delete: 1 },
      { retain: 2 },
      { insert: ["a"] },
    ]);
  });

  void it("renders a deletion tie by deleting before inserting", () => {
    assert.deepEqual(diffTokens(["x\n"], ["y\n"]), [{ delete: 1 }, { insert: ["y\n"] }]);
  });

  void it("renders equal tokens as a retain even when a cheaper delete+insert would net same tokens", () => {
    assert.deepEqual(diffTokens(["a\n", "b\n", "a\n"], ["a\n", "a\n", "b\n"]), [
      { retain: 1 },
      { delete: 1 },
      { retain: 1 },
      { insert: ["b\n"] },
    ]);
  });

  void it("diffs identical token lists to the empty script", () => {
    assert.deepEqual(diffTokens(["a\n", "b\n"], ["a\n", "b\n"]), []);
  });

  void it("handles empty sides", () => {
    assert.deepEqual(diffTokens([], ["new"]), [{ insert: ["new"] }]);
    assert.deepEqual(diffTokens(["new"], []), [{ delete: 1 }]);
    assert.deepEqual(diffTokens([], []), []);
  });

  void it("handles prepend, append, and middle insertion", () => {
    assert.deepEqual(diffTokens(["b\n"], ["a\n", "b\n"]), [{ insert: ["a\n"] }, { retain: 1 }]);
    assert.deepEqual(diffTokens(["a\n"], ["a\n", "b\n"]), [{ retain: 1 }, { insert: ["b\n"] }]);
    assert.deepEqual(diffTokens(["a\n", "c\n"], ["a\n", "b\n", "c\n"]), [
      { retain: 1 },
      { insert: ["b\n"] },
      { retain: 1 },
    ]);
  });

  void it("coalesces adjacent same-kind operations", () => {
    assert.deepEqual(diffTokens(["a\n", "b\n"], ["x\n", "y\n"]), [
      { delete: 2 },
      { insert: ["x\n", "y\n"] },
    ]);
  });
});

void describe("diffTokens and applyEditScript round-trip", () => {
  const cases: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
    [[], []],
    [[], ["a\n"]],
    [["a\n"], []],
    [["a\n"], ["b\n"]],
    [
      ["a\n", "b\n"],
      ["b\n", "a\n"],
    ],
    [
      ["a\n", "b\n", "c\n"],
      ["a\n", "c\n"],
    ],
    [
      ["a\n", "b\n", "c\n"],
      ["x\n", "a\n", "b\n", "y\n", "c\n", "z\n"],
    ],
    [
      ["a\n", "a\n", "b\n"],
      ["a\n", "b\n", "a\n"],
    ],
    [
      ["same\n", "same\n", "same\n"],
      ["same\n", "same\n"],
    ],
    [
      ["0\n", "1\n", "2\n", "3\n", "4\n"],
      ["0\n", "3\n", "4\n"],
    ],
    [
      ["0\n", "1\n", "2\n", "3\n", "4\n"],
      ["A\n", "0\n", "3\n", "4\n", "TAIL\n"],
    ],
    [
      ["0\n", "1\n", "2\n", "3\n", "4\n"],
      ["0\n", "1\n", "B\n", "3\n", "4\n"],
    ],
    [
      ["0\n", "1\n", "2\n", "3\n", "4\n"],
      ["0\n", "2\n", "3\n", "4\n"],
    ],
    [
      ["0\n", "1\n", "2\n", "3\n", "4\n"],
      ["0\n", "B\n", "1\n", "2\n", "3\n", "4\n"],
    ],
    [
      ["0\n", "1\n", "2\n", "3\n", "4\n"],
      ["0\n", "1\n", "2\n", "3\n", "4\n", "A\n"],
    ],
    [
      ["first\n", "last"],
      ["last", "first\n"],
    ],
  ];
  for (const [oldTokens, newTokens] of cases) {
    void it(`round-trips ${JSON.stringify(oldTokens)} -> ${JSON.stringify(newTokens)}`, () => {
      roundTrip(oldTokens, newTokens);
    });
  }
});

void describe("validateEditScript", () => {
  void it("accepts a consuming script and returns the applied result", () => {
    const oldTokens = ["a\n", "b\n"];
    const cases: ReadonlyArray<readonly [EditScript, readonly string[]]> = [
      [[{ delete: 2 }], []],
      [[{ retain: 1 }, { delete: 1 }], ["a\n"]],
      [[{ insert: ["x\n"] }, { delete: 2 }], ["x\n"]],
    ];
    for (const [script, expected] of cases) {
      const result = validateEditScript(oldTokens, script);
      assert.equal(result._tag, "ok");
      assert.deepEqual(result.value.result, expected);
    }
  });

  void it("accepts the empty script only for an empty old token list", () => {
    const result = validateEditScript([], []);
    assert.equal(result._tag, "ok");
    assert.deepEqual(result.value.result, []);
  });

  void it("rejects zero and non-integer counts", () => {
    const oldTokens = ["a\n"];
    assert.equal(validateEditScript(oldTokens, [{ retain: 0 }])._tag, "err");
    assert.equal(validateEditScript(oldTokens, [{ delete: 0 }])._tag, "err");
    assert.equal(validateEditScript(oldTokens, [{ retain: 1.5 }])._tag, "err");
    assert.equal(validateEditScript(oldTokens, [{ delete: -1 }])._tag, "err");
  });

  void it("rejects an empty insert", () => {
    const oldTokens = ["a\n"];
    const result = validateEditScript(oldTokens, [{ insert: [] }, { delete: 1 }]);
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "insert is empty");
  });

  void it("rejects adjacent same-kind operations with the current kind named", () => {
    const oldTokens = ["a\n", "b\n"];
    const cases: ReadonlyArray<readonly [EditScript, string]> = [
      [[{ insert: ["a\n"] }, { insert: ["b\n"] }, { delete: 2 }], "adjacent insert"],
      [[{ retain: 1 }, { retain: 1 }], "adjacent retain"],
      [[{ delete: 1 }, { delete: 1 }], "adjacent delete"],
    ];
    for (const [script, detail] of cases) {
      const result = validateEditScript(oldTokens, script);
      assert.equal(result._tag, "err");
      assert.equal(result.detail, detail);
    }
  });

  void it("rejects under-consumption and over-consumption", () => {
    const oldTokens = ["a\n", "b\n"];
    const under = validateEditScript(oldTokens, [{ retain: 1 }]);
    assert.equal(under._tag, "err");
    assert.equal(under.detail, "edit does not consume old content");
    const over = validateEditScript(["a\n"], [{ delete: 2 }]);
    assert.equal(over._tag, "err");
    assert.equal(over.detail, "edit consumes beyond old content");
  });
});
