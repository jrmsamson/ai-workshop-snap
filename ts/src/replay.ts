import { applyEditScript, diffTokens } from "./diff.js";
import { transformEdit } from "./ot.js";
import { applyPatchToTree } from "./patch.js";
import { compareTrackedPath, pathSegmentsSharePrefix } from "./path.js";
import { textToUtf8, tokenizeBytes } from "./text.js";
import type {
  Change,
  ContributorId,
  Patch,
  Result,
  Revision,
  TrackedPath,
  Tree,
  Version,
  Warning,
} from "./types.js";
import { err, ok } from "./types.js";
import { snapCompare } from "./version.js";

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => {
  if (a === undefined || b === undefined) {
    return a === b;
  }
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

/** A patch's result version (§4.2): its base with its author's counter set to its revision. */
export const patchResultVersion = (patch: Patch): Version => {
  const entries = new Map<ContributorId, Revision>();
  for (const [id, revision] of patch.base) {
    entries.set(id, revision);
  }
  entries.set(patch.author, patch.revision);
  const sorted = Array.from(entries, ([id, revision]) => [id, revision] as const);
  sorted.sort((a, b) => compareTrackedPath(a[0], b[0]));
  return sorted;
};

/** §6.1 least-ready ordering: result Snap order, then author bytes, then revision. */
const comparePatchOrder = (a: Patch, b: Patch): number => {
  const byVersion = snapCompare(patchResultVersion(a), patchResultVersion(b));
  if (byVersion !== 0) {
    return byVersion;
  }
  const byAuthor = compareTrackedPath(a.author, b.author);
  if (byAuthor !== 0) {
    return byAuthor;
  }
  return a.revision - b.revision;
};

export type ReplayResult = { readonly tree: Tree; readonly warnings: readonly Warning[] };

const selectionFor = (patches: readonly Patch[], version: Version): readonly Patch[] => {
  const counters = new Map<ContributorId, Revision>();
  for (const [id, revision] of version) {
    counters.set(id, revision);
  }
  return patches.filter((patch) => (counters.get(patch.author) ?? 0) >= patch.revision);
};

/**
 * Deterministic canonical replay (§6). `patches` must be a validated, closed,
 * acyclic history. Returns the materialized tree and the unique, sorted
 * warning pairs emitted while integrating in canonical order.
 */
export const replayVersion = (
  patches: readonly Patch[],
  version: Version,
): Result<ReplayResult> => {
  const selected = selectionFor(patches, version);
  const integrated: Map<ContributorId, Revision> = new Map();
  const cache = new Map<string, Result<Tree>>();

  const baseReady = (base: Version): boolean => {
    for (const [id, revision] of base) {
      if ((integrated.get(id) ?? 0) < revision) {
        return false;
      }
    }
    return true;
  };

  /** Tree of a (sub)version, computed in its own canonical pass; memoized. */
  const materialize = (target: Version): Result<Tree> => {
    const key = JSON.stringify(target);
    const memoized = cache.get(key);
    if (memoized !== undefined) {
      return memoized;
    }
    const localIntegrated: Map<ContributorId, Revision> = new Map();
    const targetCounters = new Map<ContributorId, Revision>();
    for (const [id, revision] of target) {
      targetCounters.set(id, revision);
    }
    let pending = patches.filter(
      (patch) => (targetCounters.get(patch.author) ?? 0) >= patch.revision,
    );
    let tree: Tree = new Map<TrackedPath, Uint8Array>();
    const readyOf = (candidate: Patch): boolean => {
      for (const [id, revision] of candidate.base) {
        if ((localIntegrated.get(id) ?? 0) < revision) {
          return false;
        }
      }
      return true;
    };
    for (;;) {
      if (pending.length === 0) {
        cache.set(key, ok(tree));
        return ok(tree);
      }
      const ready = pending.filter(readyOf);
      if (ready.length === 0) {
        return err("cyclic or incomplete patch history");
      }
      let chosen = ready[0] as Patch;
      for (const candidate of ready) {
        if (comparePatchOrder(candidate, chosen) < 0) {
          chosen = candidate;
        }
      }
      const baseTreeResult = materialize(chosen.base);
      if (baseTreeResult._tag === "err") {
        return baseTreeResult;
      }
      const step = integrateOne(chosen, baseTreeResult.value, tree);
      if (step._tag === "err") {
        return step;
      }
      tree = step.value.tree;
      localIntegrated.set(chosen.author, chosen.revision);
      pending = pending.filter((patch) => patch !== chosen);
    }
  };

  const warnings: Warning[] = [];
  let current: Tree = new Map<TrackedPath, Uint8Array>();
  let pending = selected;
  for (;;) {
    if (pending.length === 0) {
      break;
    }
    const ready = pending.filter((patch) => baseReady(patch.base));
    if (ready.length === 0) {
      return err("cyclic or incomplete patch history");
    }
    let chosen = ready[0] as Patch;
    for (const candidate of ready) {
      if (comparePatchOrder(candidate, chosen) < 0) {
        chosen = candidate;
      }
    }
    const baseTreeResult = materialize(chosen.base);
    if (baseTreeResult._tag === "err") {
      return baseTreeResult;
    }
    const step = integrateOne(chosen, baseTreeResult.value, current);
    if (step._tag === "err") {
      return step;
    }
    current = step.value.tree;
    warnings.push(...step.value.warnings);
    integrated.set(chosen.author, chosen.revision);
    pending = pending.filter((patch) => patch !== chosen);
  }

  const unique = new Map<string, Warning>();
  for (const warning of warnings) {
    unique.set(`${warning.path}\u0000${warning.reason}`, warning);
  }
  const sorted = Array.from(unique.values()).sort((a, b) => {
    const byPath = compareTrackedPath(a.path, b.path);
    if (byPath !== 0) {
      return byPath;
    }
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });
  return ok({ tree: current, warnings: sorted });
};

type Resolved =
  | { readonly kind: "set"; readonly bytes: Uint8Array }
  | { readonly kind: "delete" }
  | { readonly kind: "none" };

const integrateOne = (
  patch: Patch,
  base: Tree,
  current: Tree,
): Result<{ readonly tree: Tree; readonly warnings: readonly Warning[] }> => {
  const authoredResult = applyPatchToTree(patch, base);
  if (authoredResult._tag === "err") {
    return authoredResult;
  }
  const authoredTree = authoredResult.value;

  // S: paths the patch makes present. `deleted`: paths present in base but absent after.
  const deleted = patch.changes
    .map((change) => change.path)
    .filter((path) => base.has(path) && !authoredTree.has(path));

  const removed = new Set<TrackedPath>();
  const installed = new Map<TrackedPath, Uint8Array>();
  const namespaceWarnings: Warning[] = [];

  // C': the current tree with this patch's authored deletions removed.
  const Cprime = new Map<TrackedPath, Uint8Array>(current);
  for (const path of deleted) {
    Cprime.delete(path);
  }

  // §6.2 namespace resolution: an incoming path that the patch itself makes
  // present, colliding with a different current ancestor/descendant file, is
  // installed and the conflicting file removed. Only the patch's own non-delete
  // changes count as "made present" — inherited, untouched base paths must not
  // clobber unrelated concurrent descendants.
  for (const change of patch.changes) {
    if (change.type === "delete") {
      continue;
    }
    const s = change.path;
    const bytes = authoredTree.get(s);
    if (bytes === undefined) {
      continue;
    }
    for (const [q] of Cprime) {
      if (q !== s && pathSegmentsSharePrefix(q, s)) {
        removed.add(q);
        namespaceWarnings.push({ path: q, reason: "namespace-wins" });
        installed.set(s, bytes);
      }
    }
  }

  const pathWarnings: Warning[] = [];
  const resolved = new Map<TrackedPath, Resolved>();

  for (const change of patch.changes) {
    const s = change.path;
    if (installed.has(s)) {
      continue;
    }
    const bp = base.get(s);
    const cp = current.get(s);
    const tp = authoredTree.get(s);

    let decision: Resolved;
    if (sameBytes(bp, cp)) {
      decision = tp === undefined ? { kind: "delete" } : { kind: "set", bytes: tp };
    } else if (sameBytes(cp, tp)) {
      decision = { kind: "none" };
    } else if (change.type === "text" && bp !== undefined && cp !== undefined && tp !== undefined) {
      const tokensB = tokenizeBytes(bp);
      const tokensC = tokenizeBytes(cp);
      if (tokensB !== null && tokensC !== null) {
        const q = diffTokens(tokensB, tokensC);
        const transformed = transformEdit(change.edit, q);
        const resultTokens = applyEditScript(tokensC, transformed);
        decision = { kind: "set", bytes: textToUtf8(resultTokens.join("")) };
      } else {
        decision = pathLevel(bp, cp, tp, change, pathWarnings);
      }
    } else {
      decision = pathLevel(bp, cp, tp, change, pathWarnings);
    }
    resolved.set(s, decision);
  }

  const next = new Map<TrackedPath, Uint8Array>(current);
  for (const q of removed) {
    next.delete(q);
  }
  for (const [s, bytes] of installed) {
    next.set(s, bytes);
  }
  for (const [s, decision] of resolved) {
    if (decision.kind === "set") {
      next.set(s, decision.bytes);
    } else if (decision.kind === "delete") {
      next.delete(s);
    }
  }

  return ok({ tree: next, warnings: [...namespaceWarnings, ...pathWarnings] });
};

/** §6.4 path-level rules, evaluated in order. */
const pathLevel = (
  bp: Uint8Array | undefined,
  cp: Uint8Array | undefined,
  tp: Uint8Array | undefined,
  change: Change,
  warnings: Warning[],
): Resolved => {
  const path = change.path;
  if (sameBytes(cp, tp)) {
    return { kind: "none" };
  }
  if (tp === undefined) {
    warnings.push({ path, reason: "delete-wins" });
    return { kind: "delete" };
  }
  if (bp !== undefined && cp === undefined) {
    warnings.push({ path, reason: "delete-wins" });
    return { kind: "delete" };
  }
  if (bp === undefined && cp !== undefined) {
    warnings.push({ path, reason: "later-create-wins" });
    return { kind: "set", bytes: tp };
  }
  if (change.type === "put") {
    warnings.push({ path, reason: "later-put-wins" });
    return { kind: "set", bytes: tp };
  }
  warnings.push({ path, reason: "put-wins" });
  return { kind: "none" };
};

/** Canonical §6.1 integration order over a complete patch history. */
export const integrationOrder = (patches: readonly Patch[]): Result<readonly Patch[]> => {
  const integrated: Map<ContributorId, Revision> = new Map();
  const order: Patch[] = [];
  let pending = [...patches];
  for (;;) {
    if (pending.length === 0) {
      return ok(order);
    }
    const ready = pending.filter((patch) => {
      for (const [id, revision] of patch.base) {
        if ((integrated.get(id) ?? 0) < revision) {
          return false;
        }
      }
      return true;
    });
    if (ready.length === 0) {
      return err("cyclic or incomplete patch history");
    }
    let chosen = ready[0] as Patch;
    for (const candidate of ready) {
      if (comparePatchOrder(candidate, chosen) < 0) {
        chosen = candidate;
      }
    }
    order.push(chosen);
    integrated.set(chosen.author, chosen.revision);
    pending = pending.filter((patch) => patch !== chosen);
  }
};
