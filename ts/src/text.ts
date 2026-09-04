import { TextDecoder, TextEncoder } from "node:util";

/**
 * Decodes UTF-8 bytes to a string, or returns null when the bytes are not
 * valid UTF-8 (SPEC §4.4).
 */
export const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};

/**
 * A file is text when its bytes are valid UTF-8 and contain no NUL. A NUL byte
 * in valid UTF-8 necessarily decodes to U+0000, so checking the decoded string
 * for U+0000 is equivalent (SPEC §4.4).
 */
export const isText = (bytes: Uint8Array): boolean => {
  const decoded = decodeUtf8(bytes);
  return decoded !== null && !decoded.includes("\u0000");
};

/** UTF-8 encodes a string. */
export const textToUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Canonical token split: split immediately after every LF byte, retaining the
 * LF in the token (SPEC §4.4). The empty string has no tokens.
 */
export const tokenize = (s: string): readonly string[] => {
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      tokens.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) tokens.push(s.slice(start));
  return tokens;
};

/**
 * True when `tokens` is the canonical token sequence of some file: every token
 * is nonempty, contains no LF before its final byte, and every token except
 * possibly the final one ends in LF (SPEC §4.4).
 */
export const isCanonicalTokenSeq = (tokens: readonly string[]): boolean => {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token.length === 0) return false;
    const nlAt = token.indexOf("\n");
    if (nlAt !== -1 && nlAt !== token.length - 1) return false;
    if (nlAt === -1 && i < tokens.length - 1) return false;
  }
  return true;
};

/**
 * Tokenizes bytes when they are text; returns null for non-text (invalid UTF-8
 * or NUL-containing) content.
 */
export const tokenizeBytes = (bytes: Uint8Array): readonly string[] | null => {
  const decoded = decodeUtf8(bytes);
  if (decoded === null || decoded.includes("\u0000")) return null;
  return tokenize(decoded);
};
