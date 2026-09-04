import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tokenize } from "./text.js";
import type { EditOp, EditScript, TextToken } from "./types.js";
import { applyEditScript, diffTokens } from "./diff.js";
import { transformEdit } from "./ot.js";

const tokens = (text: string): readonly TextToken[] => tokenize(text);

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

/** Merges `incomingText` (authored on `baseText`) after `contextText` is current. */
const mergeFiles = (baseText: string, incomingText: string, contextText: string): string => {
  const base = tokens(baseText);
  const incoming = tokens(incomingText);
  const context = tokens(contextText);
  const transformed = transformEdit(diffTokens(base, incoming), diffTokens(base, context));
  assert.equal(
    hasAdjacentSameKind(transformed),
    false,
    "transform output must have no adjacent same-kind ops",
  );
  return applyEditScript(context, transformed).join("");
};

/** Transforms raw context edit `q` and incoming edit `p` over `baseTokens`. */
const mergeRaw = (
  baseTokens: readonly TextToken[],
  q: EditScript,
  p: EditScript,
): { readonly script: EditScript; readonly merged: string } => {
  const script = transformEdit(p, q);
  assert.equal(
    hasAdjacentSameKind(script),
    false,
    "transform output must have no adjacent same-kind ops",
  );
  return { script, merged: applyEditScript(applyEditScript(baseTokens, q), script).join("") };
};

void describe("transformEdit table rows (SPEC 6.3)", () => {
  void it("Q insert emits a retain and consumes Q only", () => {
    const { script, merged } = mergeRaw(
      tokens("a\n"),
      [{ insert: ["Q\n"] }, { retain: 1 }],
      [{ retain: 1 }],
    );
    assert.deepEqual(script, [{ retain: 2 }]);
    assert.equal(merged, "Q\na\n");
  });

  void it("P insert is emitted unchanged and consumes P only", () => {
    const { script, merged } = mergeRaw(
      tokens("a\nb\n"),
      [{ retain: 2 }],
      [{ retain: 1 }, { insert: ["P\n"] }, { retain: 1 }],
    );
    assert.deepEqual(script, [{ retain: 1 }, { insert: ["P\n"] }, { retain: 1 }]);
    assert.equal(merged, "a\nP\nb\n");
  });

  void it("splits counts across op boundaries across all four retain/delete rows", () => {
    const { script, merged } = mergeRaw(
      tokens("0\n1\n2\n3\n"),
      [{ delete: 1 }, { retain: 2 }, { delete: 1 }],
      [{ retain: 2 }, { delete: 2 }],
    );
    assert.deepEqual(script, [{ retain: 1 }, { delete: 1 }]);
    assert.equal(merged, "1\n");
  });

  void it("overlapping deletes delete each base token once", () => {
    const { script, merged } = mergeRaw(
      tokens("0\n1\n2\n"),
      [{ retain: 1 }, { delete: 1 }, { retain: 1 }],
      [{ delete: 2 }, { retain: 1 }],
    );
    assert.deepEqual(script, [{ delete: 1 }, { retain: 1 }]);
    assert.equal(merged, "2\n");
  });

  void it("fully overlapping P delete and Q delete emit nothing", () => {
    const { script, merged } = mergeRaw(tokens("0\n1\n"), [{ delete: 2 }], [{ delete: 2 }]);
    assert.deepEqual(script, []);
    assert.equal(merged, "");
  });

  void it("a Q insert before a P delete survives (deletes consume base only)", () => {
    const { script, merged } = mergeRaw(
      tokens("0\n1\n"),
      [{ insert: ["Q\n"] }, { retain: 2 }],
      [{ delete: 1 }, { retain: 1 }],
    );
    assert.deepEqual(script, [{ retain: 1 }, { delete: 1 }, { retain: 1 }]);
    assert.equal(merged, "Q\n1\n");
  });

  void it("same-cursor P and Q inserts order Q first (Q insert row has priority)", () => {
    const { script, merged } = mergeRaw(
      tokens("0\n"),
      [{ insert: ["Q\n"] }, { retain: 1 }],
      [{ insert: ["P\n"] }, { retain: 1 }],
    );
    assert.deepEqual(script, [{ retain: 1 }, { insert: ["P\n"] }, { retain: 1 }]);
    assert.equal(merged, "Q\nP\n0\n");
  });

  void it("handles a trailing P insert", () => {
    const { script, merged } = mergeRaw(
      tokens("0\n"),
      [{ retain: 1 }],
      [{ retain: 1 }, { insert: ["P\n"] }],
    );
    assert.deepEqual(script, [{ retain: 1 }, { insert: ["P\n"] }]);
    assert.equal(merged, "0\nP\n");
  });

  void it("handles a trailing Q insert, coalescing adjacent retains", () => {
    const { script, merged } = mergeRaw(
      tokens("0\n"),
      [{ retain: 1 }, { insert: ["Q\n"] }],
      [{ retain: 1 }],
    );
    assert.deepEqual(script, [{ retain: 2 }]);
    assert.equal(merged, "0\nQ\n");
  });

  void it("a token P retains but Q deletes emits nothing", () => {
    const { script, merged } = mergeRaw(
      tokens("0\n1\n"),
      [{ delete: 1 }, { retain: 1 }],
      [{ retain: 2 }],
    );
    assert.deepEqual(script, [{ retain: 1 }]);
    assert.equal(merged, "1\n");
  });
});

void describe("SPEC 22 merge scenarios reproduce exactly", () => {
  const base = "0\n1\n2\n3\n4\n";

  void it("P delete / Q delete overlapping: dd-from-a and dd-from-b both reach 0\n3\n4", () => {
    assert.equal(mergeFiles(base, "0\n2\n3\n4\n", "0\n3\n4\n"), "0\n3\n4\n");
    assert.equal(mergeFiles(base, "0\n3\n4\n", "0\n2\n3\n4\n"), "0\n3\n4\n");
  });

  void it("count splitting, insert priority, and trailing inserts reach A\n0\nB\n3\n4\nTAIL", () => {
    assert.equal(
      mergeFiles(base, "0\n1\nB\n3\n4\n", "A\n0\n3\n4\nTAIL\n"),
      "A\n0\nB\n3\n4\nTAIL\n",
    );
    assert.equal(
      mergeFiles(base, "A\n0\n3\n4\nTAIL\n", "0\n1\nB\n3\n4\n"),
      "A\n0\nB\n3\n4\nTAIL\n",
    );
  });

  void it("P retain / Q delete keeps the delete: rd reaches 0\n2\n3\n4\nA", () => {
    assert.equal(mergeFiles(base, "0\n2\n3\n4\n", "0\n1\n2\n3\n4\nA\n"), "0\n2\n3\n4\nA\n");
  });

  void it("Q insert before a P deletion survives: survive reaches 0\nB\n2\n3\n4", () => {
    assert.equal(mergeFiles(base, "0\nB\n1\n2\n3\n4\n", "0\n2\n3\n4\n"), "0\nB\n2\n3\n4\n");
  });
});
