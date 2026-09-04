import { TextEncoder } from "node:util";

import { err, ok, type Result, type TrackedPath } from "./types.js";

const utf8 = new TextEncoder();

/** True when `p` contains an ASCII control character (U+0000..U+001F or U+007F). */
const hasAsciiControl = (p: string): boolean => {
  for (let i = 0; i < p.length; i++) {
    const unit = p.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
};

/**
 * Validates a tracked path per SPEC §2: nonempty UTF-8 relative path using `/`
 * separators with no ASCII control character, no backslash, no empty/`.`/`..`
 * segment, and no first segment equal to `.snap`. No Unicode or case
 * normalization. Success returns the same string.
 */
export const validateTrackedPath = (p: string): Result<TrackedPath> => {
  const invalid = (): Result<TrackedPath> => err(`path is invalid: ${p}`);
  if (p.length === 0 || hasAsciiControl(p) || p.includes("\\")) return invalid();
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return invalid();
  if ((segments[0] as string) === ".snap") return invalid();
  return ok(p);
};

/**
 * Compares two tracked paths by unsigned lexicographic UTF-8 bytes (SPEC §2).
 * UTF-8 preserves code-point order, so encoding each side and byte-comparing is
 * equivalent; comparing JS strings by code unit would not be in general.
 */
export const compareTrackedPath = (a: string, b: string): number => {
  if (a === b) return 0;
  const bytesA = utf8.encode(a);
  const bytesB = utf8.encode(b);
  const common = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < common; i++) {
    const byteA = bytesA[i] as number;
    const byteB = bytesB[i] as number;
    if (byteA !== byteB) return byteA < byteB ? -1 : 1;
  }
  if (bytesA.length !== bytesB.length) return bytesA.length < bytesB.length ? -1 : 1;
  return 0;
};

/** Splits a tracked path into its `/`-separated segments. */
export const splitPath = (p: string): readonly string[] => p.split("/");

/**
 * Whole-segment prefix test: true when `p` equals `ancestor` or lives strictly
 * below it (`ancestor/...`). Total on arbitrary strings.
 */
export const isPathPrefixOrEqual = (ancestor: string, p: string): boolean =>
  ancestor === "" || p === ancestor || p.startsWith(`${ancestor}/`);

/** Whole-segment strict prefix test: true when `p` lives strictly below `ancestor`. */
export const isStrictPathPrefix = (ancestor: string, p: string): boolean =>
  ancestor !== "" && p !== ancestor && p.startsWith(`${ancestor}/`);

/**
 * True when `a` and `b` collide in one namespace: identical or one is a
 * whole-segment ancestor of the other. Used for prefix-free checks and §6.2
 * namespace resolution.
 */
export const pathSegmentsSharePrefix = (a: string, b: string): boolean =>
  a === b || isStrictPathPrefix(a, b) || isStrictPathPrefix(b, a);
