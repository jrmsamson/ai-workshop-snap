import type { ContributorId, Result } from "./types.js";
import { err, ok } from "./types.js";

const encoder = new TextEncoder();

const invalid = (id: string): Result<ContributorId> => err(`invalid contributor id: ${id}`);

/**
 * Validates a contributor ID (SPEC §3.1): ASCII, exactly one `@` with nonempty
 * text on both sides, no control character, no whitespace, no `,`, `(`, `)`,
 * or substring `->`, and at most 254 bytes.
 */
export const validateContributorId = (id: string): Result<ContributorId> => {
  const bytes = encoder.encode(id);
  if (bytes.length > 254) {
    return invalid(id);
  }
  let atIndex = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === undefined) {
      return invalid(id);
    }
    if (b > 0x7f || b < 0x20 || b === 0x7f) {
      return invalid(id);
    }
    if (b === 0x20) {
      return invalid(id);
    }
    if (b === 0x2c || b === 0x28 || b === 0x29) {
      return invalid(id);
    }
    if (b === 0x2d) {
      const next = bytes[i + 1];
      if (next === 0x3e) {
        return invalid(id);
      }
    }
    if (b === 0x40) {
      if (atIndex !== -1) {
        return invalid(id);
      }
      atIndex = i;
    }
  }
  if (atIndex === -1 || atIndex === 0 || atIndex === bytes.length - 1) {
    return invalid(id);
  }
  return ok(id);
};
