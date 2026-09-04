import { err, ok } from "./types.js";
import type { EditOp, EditScript, Result, TextToken } from "./types.js";

type OpKind = "insert" | "retain" | "delete";

const kindOf = (op: EditOp): OpKind =>
  "insert" in op ? "insert" : "retain" in op ? "retain" : "delete";

const sameTokens = (a: readonly TextToken[], b: readonly TextToken[]): boolean => {
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

/** Reads `table[i][j]`; out-of-bounds reads (never used) yield 0. */
const cell = (table: readonly (readonly number[])[], i: number, j: number): number => {
  const row = table[i];
  if (row === undefined) {
    return 0;
  }
  const value = row[j];
  return value === undefined ? 0 : value;
};

const addRetain = (out: EditOp[], count: number): void => {
  const last = out[out.length - 1];
  if (last !== undefined && "retain" in last) {
    out[out.length - 1] = { retain: last.retain + count };
  } else {
    out.push({ retain: count });
  }
};

const addDelete = (out: EditOp[], count: number): void => {
  const last = out[out.length - 1];
  if (last !== undefined && "delete" in last) {
    out[out.length - 1] = { delete: last.delete + count };
  } else {
    out.push({ delete: count });
  }
};

const addInsert = (out: EditOp[], tokens: readonly TextToken[]): void => {
  const last = out[out.length - 1];
  if (last !== undefined && "insert" in last) {
    out[out.length - 1] = { insert: [...last.insert, ...tokens] };
  } else {
    out.push({ insert: tokens });
  }
};

const isPositiveCount = (count: number): boolean => Number.isSafeInteger(count) && count > 0;

/**
 * The canonical token diff (SPEC §5): minimum inserts/deletes to transform
 * `oldTokens` into `newTokens`, computed with the plain O(n*m) table. Equal
 * tokens retain; on a tie between deleting and inserting, deleting wins.
 * Adjacent same-kind operations are coalesced. Identical token lists diff to
 * the empty script.
 */
export const diffTokens = (
  oldTokens: readonly TextToken[],
  newTokens: readonly TextToken[],
): EditScript => {
  if (sameTokens(oldTokens, newTokens)) {
    return [];
  }
  const n = oldTokens.length;
  const m = newTokens.length;
  const table: number[][] = new Array<number[]>(n + 1);
  for (let i = n; i >= 0; i -= 1) {
    const row = new Array<number>(m + 1);
    row[m] = n - i;
    for (let j = m - 1; j >= 0; j -= 1) {
      if (i === n) {
        row[j] = m - j;
      } else {
        if (oldTokens[i] === newTokens[j]) {
          row[j] = cell(table, i + 1, j + 1);
        } else {
          row[j] = 1 + Math.min(cell(table, i + 1, j), row[j + 1] as number);
        }
      }
    }
    table[i] = row;
  }
  const script: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j]) {
      addRetain(script, 1);
      i += 1;
      j += 1;
    } else if (cell(table, i + 1, j) <= cell(table, i, j + 1)) {
      addDelete(script, 1);
      i += 1;
    } else {
      addInsert(script, [newTokens[j] as TextToken]);
      j += 1;
    }
  }
  while (i < n) {
    addDelete(script, 1);
    i += 1;
  }
  while (j < m) {
    addInsert(script, [newTokens[j] as TextToken]);
    j += 1;
  }
  return script;
};

/**
 * Applies a valid, consuming edit script to old tokens (SPEC §4.4): retain
 * copies tokens, delete skips tokens, insert splices tokens in. Callers
 * guarantee the script is valid and consumes the complete old sequence.
 */
export const applyEditScript = (
  oldTokens: readonly TextToken[],
  script: EditScript,
): readonly TextToken[] => {
  const out: TextToken[] = [];
  let i = 0;
  for (const op of script) {
    if ("retain" in op) {
      for (let k = 0; k < op.retain; k += 1) {
        const token = oldTokens[i + k];
        if (token !== undefined) {
          out.push(token);
        }
      }
      i += op.retain;
    } else if ("delete" in op) {
      i += op.delete;
    } else {
      for (const token of op.insert) {
        out.push(token);
      }
    }
  }
  return out;
};

/**
 * Validates an edit script against old tokens (SPEC §4.4): counts are positive
 * safe integers, inserts hold at least one token, no two adjacent operations
 * share a kind, and the script consumes exactly the complete old sequence. On
 * success returns the resulting token sequence.
 */
export const validateEditScript = (
  oldTokens: readonly TextToken[],
  script: EditScript,
): Result<{ readonly result: readonly TextToken[] }> => {
  const n = oldTokens.length;
  let consumed = 0;
  let previous: EditOp | undefined;
  for (const op of script) {
    if ("retain" in op) {
      if (!isPositiveCount(op.retain)) {
        return err("retain count must be a positive safe integer");
      }
      consumed += op.retain;
    } else if ("delete" in op) {
      if (!isPositiveCount(op.delete)) {
        return err("delete count must be a positive safe integer");
      }
      consumed += op.delete;
    } else if (op.insert.length === 0) {
      return err("insert is empty");
    } else {
      for (const token of op.insert) {
        if (token.length === 0) {
          return err("insert token must be a nonempty string");
        }
        const nl = token.indexOf("\n");
        if (nl !== -1 && nl !== token.length - 1) {
          return err("insert token must not contain an interior newline");
        }
      }
    }
    if (previous !== undefined && kindOf(previous) === kindOf(op)) {
      return err(`adjacent ${kindOf(op)}`);
    }
    previous = op;
    if (consumed > n) {
      return err("edit consumes beyond old content");
    }
  }
  if (consumed < n) {
    return err("edit does not consume old content");
  }
  return ok({ result: applyEditScript(oldTokens, script) });
};
