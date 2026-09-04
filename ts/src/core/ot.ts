import type { EditOp, EditScript } from "./types.js";

/** Appends `op` to `out`, coalescing adjacent operations of the same kind. */
const emit = (out: EditOp[], op: EditOp): void => {
  const last = out[out.length - 1];
  if (last === undefined) {
    out.push(op);
    return;
  }
  if ("retain" in last && "retain" in op) {
    out[out.length - 1] = { retain: last.retain + op.retain };
    return;
  }
  if ("delete" in last && "delete" in op) {
    out[out.length - 1] = { delete: last.delete + op.delete };
    return;
  }
  if ("insert" in last && "insert" in op) {
    out[out.length - 1] = { insert: [...last.insert, ...op.insert] };
    return;
  }
  out.push(op);
};

/**
 * Transforms an incoming edit so it applies after a context edit that consumed
 * the same base tokens (SPEC §6.3). Both scripts are processed left to right,
 * splitting counts as needed; the context-insert row has priority so concurrent
 * inserts appear in canonical integration order. Adjacent same-kind output
 * operations are coalesced. Callers guarantee both scripts consume the same
 * base token count.
 */
export const transformEdit = (incoming: EditScript, context: EditScript): EditScript => {
  const out: EditOp[] = [];
  let pi = 0;
  let qi = 0;
  let prem = 0;
  let qrem = 0;
  for (;;) {
    const pOp = pi < incoming.length ? incoming[pi] : undefined;
    const qOp = qi < context.length ? context[qi] : undefined;

    if (prem === 0 && pOp !== undefined) {
      if ("retain" in pOp) {
        prem = pOp.retain;
      } else if ("delete" in pOp) {
        prem = pOp.delete;
      }
    }
    if (qrem === 0 && qOp !== undefined) {
      if ("retain" in qOp) {
        qrem = qOp.retain;
      } else if ("delete" in qOp) {
        qrem = qOp.delete;
      }
    }

    if (qOp !== undefined && "insert" in qOp) {
      emit(out, { retain: qOp.insert.length });
      qi += 1;
      continue;
    }
    if (pOp !== undefined && "insert" in pOp) {
      emit(out, pOp);
      pi += 1;
      continue;
    }

    if (pOp === undefined && qOp === undefined) {
      break;
    }
    if (pOp === undefined || qOp === undefined) {
      break;
    }

    const pDel = "delete" in pOp;
    const qDel = "delete" in qOp;
    const step = prem < qrem ? prem : qrem;
    if (pDel) {
      if (!qDel) {
        emit(out, { delete: step });
      }
    } else if (!qDel) {
      emit(out, { retain: step });
    }
    prem -= step;
    qrem -= step;
    if (prem === 0) {
      pi += 1;
    }
    if (qrem === 0) {
      qi += 1;
    }
  }
  return out;
};
