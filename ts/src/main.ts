import { Effect } from "effect";

import { parseArgs } from "./cli/cli.js";
import {
  runCommit,
  runConfig,
  runDiff,
  runInit,
  runLog,
  runMerge,
  runRevert,
  runStatus,
} from "./cli/commands.js";
import { SnapError } from "./core/errors.js";
import { locateRepositoryRoot, requireRepository, runEffect } from "./cli/helpers.js";
import { serve } from "./http/http.js";
import {
  renderVersionOutput,
  resolvePresentation,
  sgr,
  versionLine,
} from "./presentation/presentation.js";
import { serializeRepository } from "./repository/repository.js";

export type RunEnv = {
  readonly cwd: string;
  readonly home: string | undefined;
  readonly snapColor: string | undefined;
  readonly noColor: string | undefined;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
};

const writeOut = (stream: NodeJS.WriteStream, text: string): void => {
  if (text.length > 0) {
    stream.write(text);
  }
};

const errorLine = (detail: string, term: boolean): string =>
  term ? `${sgr(31, `✗ ${detail}`)}\n` : `${detail}\n`;

export const run = async (argv: readonly string[], env: RunEnv): Promise<number> => {
  const presentationResult = resolvePresentation(
    env.snapColor,
    env.noColor,
    env.stdoutIsTty,
    env.stderrIsTty,
  );
  if (presentationResult._tag === "err") {
    process.stderr.write(`snap: ${presentationResult.detail}\n`);
    return 1;
  }
  const stdoutTerm = presentationResult.value.stdout === "terminal";
  const stderrTerm = presentationResult.value.stderr === "terminal";

  const parsed = parseArgs(argv);
  if (parsed._tag === "err") {
    process.stderr.write(errorLine(`snap: ${parsed.detail}`, stderrTerm));
    return 1;
  }
  const cmd = parsed.value;
  const ctx = { cwd: env.cwd, home: env.home, stdoutTerm, stderrTerm };

  if (cmd.kind === "version") {
    writeOut(process.stdout, stdoutTerm ? renderVersionOutput() : `${versionLine()}\n`);
    return 0;
  }

  try {
    if (cmd.kind === "serve") {
      const root = await runEffect(locateRepositoryRoot(env.cwd));
      const repo = await runEffect(
        root === undefined
          ? Effect.fail(new SnapError({ detail: "not a Snap repository", code: 1 }))
          : requireRepository(root),
      );
      await runEffect(serve(serializeRepository(repo), cmd.port));
      return 0;
    }

    let out: { readonly stdout: string; readonly stderr: string };
    switch (cmd.kind) {
      case "init":
        out = await runInit(ctx, cmd.path);
        break;
      case "config":
        out = await runConfig(ctx, cmd.global, cmd.id);
        break;
      case "status":
        out = await runStatus(ctx);
        break;
      case "log":
        out = await runLog(ctx);
        break;
      case "commit":
        out = await runCommit(ctx, cmd.message);
        break;
      case "diff":
        out = await runDiff(ctx, cmd.target);
        break;
      case "revert":
        out = await runRevert(ctx, cmd.version);
        break;
      case "merge":
        out = await runMerge(ctx, cmd.operand);
        break;
    }
    writeOut(process.stdout, out.stdout);
    writeOut(process.stderr, out.stderr);
    return 0;
  } catch (error) {
    if (error instanceof SnapError) {
      process.stderr.write(errorLine(`snap: ${error.detail}`, stderrTerm));
      return error.code;
    }
    process.stderr.write(errorLine("snap: internal error", stderrTerm));
    return 2;
  }
};

export const main = (): void => {
  const env: RunEnv = {
    cwd: process.cwd(),
    home: process.env["HOME"],
    snapColor: process.env["SNAP_COLOR"],
    noColor: process.env["NO_COLOR"],
    stdoutIsTty: process.stdout.isTTY,
    stderrIsTty: process.stderr.isTTY,
  };
  run(process.argv.slice(2), env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 2;
    });
};

main();
