import type { Result } from "./types.js";
import { err, ok } from "./types.js";

export type StreamMode = "terminal" | "plain";

export type Presentation = {
  readonly stdout: StreamMode;
  readonly stderr: StreamMode;
};

export const bold = 1;
export const dim = 2;
export const red = 31;
export const green = 32;
export const yellow = 33;
export const magenta = 35;
export const cyan = 36;

const ESC = "\u001b";

/**
 * Wraps `text` in an ANSI SGR span: `ESC[<code>m<text>ESC[0m` (SPEC §7.11).
 * The reset is always emitted, so spans never leak styling.
 */
export const sgr = (code: number, text: string): string =>
  `${ESC}[${String(code)}m${text}${ESC}[0m`;

/**
 * Selects the presentation for each stream from `SNAP_COLOR` and `NO_COLOR`
 * (SPEC §7.11). `always` forces terminal on both streams and overrides
 * `NO_COLOR`; `never` forces plain; `auto` or an unset `SNAP_COLOR` selects
 * terminal independently per stream exactly when that stream is a TTY, unless
 * `NO_COLOR` is present (even empty), which forces plain on both. Any other
 * value is an error.
 */
export const resolvePresentation = (
  snapColor: string | undefined,
  noColor: string | undefined,
  stdoutIsTty: boolean,
  stderrIsTty: boolean,
): Result<Presentation> => {
  switch (snapColor) {
    case "always":
      return ok({ stdout: "terminal", stderr: "terminal" });
    case "never":
      return ok({ stdout: "plain", stderr: "plain" });
    case undefined:
    case "auto":
      if (noColor !== undefined) {
        return ok({ stdout: "plain", stderr: "plain" });
      }
      return ok({
        stdout: stdoutIsTty ? "terminal" : "plain",
        stderr: stderrIsTty ? "terminal" : "plain",
      });
    default:
      return err("SNAP_COLOR must be auto, always, or never");
  }
};

/**
 * Escapes backslash, tab, and LF in a log message as `\\`, `\t`, and `\n`
 * (SPEC §7.4), in that order so introduced escapes are not re-escaped.
 */
export const escapeLogMessage = (message: string): string =>
  message.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");

export const renderSuccess = (label: string, version: string): string =>
  `${sgr(green, "✓")} ${sgr(bold, label)} ${sgr(cyan, version)}\n`;

export const renderStatusHeader = (version: string): string =>
  `${sgr(bold, "Snap status")}  ${sgr(cyan, version)}\n\n`;

export const renderStatusClean = (): string => `  ${sgr(green, "✓")} Working tree clean\n`;

const statusRowStyles = {
  A: { color: green, symbol: "+", label: "added" },
  M: { color: yellow, symbol: "~", label: "modified" },
  D: { color: red, symbol: "−", label: "deleted" },
} as const;

export const renderStatusRow = (code: "A" | "M" | "D", path: string): string => {
  const style = statusRowStyles[code];
  return `  ${sgr(style.color, style.symbol)} ${path} ${sgr(dim, `(${style.label})`)}\n`;
};

export const renderLogEntry = (message: string, version: string, author: string): string =>
  `${sgr(cyan, "●")} ${sgr(bold, message)}\n  ${sgr(cyan, version)} ${sgr(dim, "by")} ${sgr(magenta, author)}\n`;

export const versionLine = (): string => "snap 1.0.0";

export const renderVersionOutput = (): string => `${sgr(bold, versionLine())}\n`;
