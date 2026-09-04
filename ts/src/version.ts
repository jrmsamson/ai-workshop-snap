import type { ContributorId, ContributorRevision, Result, Revision, Version } from "./types.js";
import { err, ok } from "./types.js";
import { validateContributorId } from "./contributor.js";

const MAX_REVISION = 9007199254740991;

const encoder = new TextEncoder();

const invalidVersion = (reason: string): Result<never> => err(`invalid version: ${reason}`);

/** Compares two strings by unsigned lexicographic UTF-8 byte order. */
const compareBytes = (a: string, b: string): number => {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = ab.length < bb.length ? ab.length : bb.length;
  for (let i = 0; i < n; i += 1) {
    const x = ab[i];
    const y = bb[i];
    if (x !== undefined && y !== undefined && x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (ab.length === bb.length) {
    return 0;
  }
  return ab.length < bb.length ? -1 : 1;
};

const parseRevision = (text: string): Result<Revision> => {
  if (text.length === 0) {
    return invalidVersion("empty revision");
  }
  for (const ch of text) {
    if (ch < "0" || ch > "9") {
      return invalidVersion("revision is not an integer");
    }
  }
  if (text[0] === "0") {
    return invalidVersion("revision has a leading zero or is zero");
  }
  if (text.length > String(MAX_REVISION).length) {
    return invalidVersion("revision is out of range");
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return invalidVersion("revision is out of range");
  }
  return ok(value);
};

/** The empty version. */
export const emptyVersion = (): Version => [];

/**
 * Parses the canonical CLI form (SPEC §3.2): `()` or `(` then comma-separated
 * `id->rev` entries `)`. Ids must be strictly increasing in unsigned UTF-8 byte
 * order and each revision an integer in `[1, 9007199254740991]`.
 */
export const parseVersion = (text: string): Result<Version> => {
  if (text === "()") {
    return ok(emptyVersion());
  }
  if (!text.startsWith("(") || !text.endsWith(")")) {
    return invalidVersion("expected enclosing parentheses");
  }
  const inner = text.slice(1, -1);
  if (inner === "") {
    return invalidVersion("empty version must be written ()");
  }
  const segments = inner.split(",");
  const version: ContributorRevision[] = [];
  let previous: ContributorId | undefined;
  for (const segment of segments) {
    if (segment === "") {
      return invalidVersion("empty component");
    }
    const arrow = segment.indexOf("->");
    if (arrow === -1) {
      return invalidVersion("expected id->rev");
    }
    const idText = segment.slice(0, arrow);
    if (validateContributorId(idText)._tag === "err") {
      return invalidVersion("invalid contributor id");
    }
    const id: ContributorId = idText;
    if (previous !== undefined && compareBytes(previous, id) >= 0) {
      return invalidVersion("ids must be distinct and strictly increasing");
    }
    const revision = parseRevision(segment.slice(arrow + 2));
    if (revision._tag === "err") {
      return revision;
    }
    const entry: ContributorRevision = [id, revision.value];
    version.push(entry);
    previous = id;
  }
  return ok(version);
};

/** Formats a canonical version as `()` or `(id->rev,...)`. */
export const formatVersion = (version: Version): string => {
  if (version.length === 0) {
    return "()";
  }
  const parts: string[] = [];
  for (const [id, revision] of version) {
    parts.push(id + "->" + String(revision));
  }
  return `(${parts.join(",")})`;
};

/** Structural equality of two canonical versions. */
export const sameVersion = (a: Version, b: Version): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined || x[0] !== y[0] || x[1] !== y[1]) {
      return false;
    }
  }
  return true;
};

export type CausalRelation = "before" | "after" | "equal" | "concurrent";

const counters = (version: Version): ReadonlyMap<ContributorId, Revision> => {
  const map = new Map<ContributorId, Revision>();
  for (const [id, revision] of version) {
    map.set(id, revision);
  }
  return map;
};

/** Causal comparison (SPEC §3.3): absent components count as zero. */
export const compareCausal = (a: Version, b: Version): CausalRelation => {
  const am = counters(a);
  const bm = counters(b);
  const ids = new Set<ContributorId>([...am.keys(), ...bm.keys()]);
  let equal = true;
  let before = true;
  let after = true;
  for (const id of ids) {
    const av = am.get(id) ?? 0;
    const bv = bm.get(id) ?? 0;
    if (av !== bv) {
      equal = false;
    }
    if (av > bv) {
      before = false;
    }
    if (av < bv) {
      after = false;
    }
  }
  if (equal) {
    return "equal";
  }
  if (before) {
    return "before";
  }
  if (after) {
    return "after";
  }
  return "concurrent";
};

/** Builds a canonical, sorted version from entries. Callers guarantee valid. */
export const fromContributorRevisions = (entries: Iterable<ContributorRevision>): Version => {
  const sorted: ContributorRevision[] = Array.from(entries);
  sorted.sort((x, y) => compareBytes(x[0], y[0]));
  return sorted;
};

/** Componentwise maximum join (SPEC §3.3), returned canonical and sorted. */
export const joinVersions = (a: Version, b: Version): Version => {
  const joined = new Map<ContributorId, Revision>();
  for (const [id, revision] of a) {
    joined.set(id, revision);
  }
  for (const [id, revision] of b) {
    const current = joined.get(id) ?? 0;
    if (revision > current) {
      joined.set(id, revision);
    }
  }
  return fromContributorRevisions(joined);
};

/** Snap order (SPEC §3.4): lexicographic counters over the sorted id union. */
export const snapCompare = (a: Version, b: Version): number => {
  const am = counters(a);
  const bm = counters(b);
  const ids = Array.from(new Set<ContributorId>([...am.keys(), ...bm.keys()])).sort(compareBytes);
  for (const id of ids) {
    const av = am.get(id) ?? 0;
    const bv = bm.get(id) ?? 0;
    if (av < bv) {
      return -1;
    }
    if (av > bv) {
      return 1;
    }
  }
  return 0;
};
