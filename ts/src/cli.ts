import type { DiffTarget } from "./commands.js";
import type { Result } from "./types.js";
import { err, ok } from "./types.js";

export type Parsed =
  | { readonly kind: "init"; readonly path?: string }
  | { readonly kind: "config"; readonly global: boolean; readonly id: string }
  | { readonly kind: "status" }
  | { readonly kind: "log" }
  | { readonly kind: "commit"; readonly message: string }
  | { readonly kind: "diff"; readonly target: DiffTarget }
  | { readonly kind: "revert"; readonly version: string }
  | { readonly kind: "merge"; readonly operand: string }
  | { readonly kind: "serve"; readonly port: number }
  | { readonly kind: "version" };

const invalid = (): Result<never> => err("invalid command or arguments");

const isOptionLike = (arg: string): boolean => arg.startsWith("-");

const parsePort = (text: string): number | undefined => {
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    return undefined;
  }
  return value;
};

/** Parses the command-line arguments into a typed command (SPEC §7). */
export const parseArgs = (argv: readonly string[]): Result<Parsed> => {
  const first = argv[0];
  if (first === "--version") {
    return argv.length === 1 ? ok({ kind: "version" }) : invalid();
  }
  if (first === "--serve") {
    if (argv.length === 1) {
      return ok({ kind: "serve", port: 8765 });
    }
    if (argv.length === 2) {
      const port = parsePort(argv[1] as string);
      return port === undefined
        ? err(`invalid port: ${argv[1] as string}`)
        : ok({ kind: "serve", port });
    }
    return invalid();
  }
  switch (first) {
    case "init": {
      if (argv.length > 2) {
        return invalid();
      }
      const pathArg = argv[1];
      if (pathArg === undefined) {
        return ok({ kind: "init" });
      }
      if (isOptionLike(pathArg)) {
        return invalid();
      }
      return ok({ kind: "init", path: pathArg });
    }
    case "config": {
      if (argv.length === 3 && argv[1] === "contributor.id") {
        return ok({ kind: "config", global: false, id: argv[2] as string });
      }
      if (argv.length === 4 && argv[1] === "--global" && argv[2] === "contributor.id") {
        return ok({ kind: "config", global: true, id: argv[3] as string });
      }
      return invalid();
    }
    case "status":
      return argv.length === 1 ? ok({ kind: "status" }) : invalid();
    case "log":
      return argv.length === 1 ? ok({ kind: "log" }) : invalid();
    case "commit": {
      if (argv.length === 2) {
        return ok({ kind: "commit", message: argv[1] as string });
      }
      return invalid();
    }
    case "diff": {
      if (argv.length === 1) {
        return ok({ kind: "diff", target: { mode: "work" } });
      }
      if (argv.length === 3) {
        return ok({
          kind: "diff",
          target: { mode: "versions", oldArg: argv[1] as string, newArg: argv[2] as string },
        });
      }
      if (argv.length === 5 && argv[3] === "--repo") {
        return ok({
          kind: "diff",
          target: {
            mode: "versions",
            oldArg: argv[1] as string,
            newArg: argv[2] as string,
            repo: argv[4] as string,
          },
        });
      }
      return err("usage: snap diff <old> <new> [--repo <repository>]");
    }
    case "revert":
      return argv.length === 2 ? ok({ kind: "revert", version: argv[1] as string }) : invalid();
    case "merge":
      return argv.length === 2 ? ok({ kind: "merge", operand: argv[1] as string }) : invalid();
    default:
      return invalid();
  }
};
