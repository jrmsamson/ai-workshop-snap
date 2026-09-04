import { readContributorConfig, writeGlobalConfig, writeLocalConfig } from "./config.js";
import { validateContributorId } from "./contributor.js";
import { resolve as resolvePath } from "node:path";
import { userError } from "./errors.js";
import { ensureDir, materializeTree } from "./fsutil.js";
import {
  changesForTrees,
  ensurePrefixFree,
  isRemoteOperand,
  locateRepositoryRoot,
  newPatch,
  nextFrontier,
  replayFrontier,
  resolveLocalPath,
  requireRepository,
  revisionAfter,
  runEffect,
  treesEqual,
  treeEntries,
  withPatch,
} from "./helpers.js";
import { fetchRepository } from "./http.js";
import {
  escapeLogMessage,
  renderLogEntry,
  renderStatusClean,
  renderStatusHeader,
  renderStatusRow,
  renderSuccess,
  sgr,
} from "./presentation.js";
import { isKnownVersion, saveRepository } from "./repository.js";
import { integrationOrder, replayVersion } from "./replay.js";
import { scanWorkingTree } from "./tree.js";
import { diffTokens } from "./diff.js";
import { isText, tokenize } from "./text.js";
import { formatVersion, joinVersions, parseVersion } from "./version.js";
import { compareTrackedPath } from "./path.js";
import type { ContributorId, Patch, Repository, Result, Tree, Version } from "./types.js";
import { err, ok } from "./types.js";
import { utf8 } from "./helpers.js";

export type Ctx = {
  readonly cwd: string;
  readonly home: string | undefined;
  readonly stdoutTerm: boolean;
  readonly stderrTerm: boolean;
};

export type Out = { readonly stdout: string; readonly stderr: string };

const emptyOut = (): Out => ({ stdout: "", stderr: "" });

const guardRevision = (frontier: Version, author: ContributorId): void => {
  if (revisionAfter(frontier, author)._tag === "err") {
    throw userError("revision overflow");
  }
};

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export const runInit = async (ctx: Ctx, pathArg: string | undefined): Promise<Out> => {
  const raw = pathArg === undefined ? ctx.cwd : resolveLocalPath(pathArg, ctx.cwd);
  const target = resolvePath(raw);
  const found: string | undefined = await runEffect(locateRepositoryRoot(target));
  if (found !== undefined) {
    throw userError(
      found === target ? "repository already exists" : "cannot initialize inside repository",
    );
  }
  await runEffect(ensureDir(target));
  await runEffect(saveRepository(target, { format: 1, frontier: [], patches: [] }));
  return {
    ...emptyOut(),
    stdout: ctx.stdoutTerm ? renderSuccess("Initialized repository", "()") : "()\n",
  };
};

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const runConfig = async (ctx: Ctx, isGlobal: boolean, idArg: string): Promise<Out> => {
  const idResult = validateContributorId(idArg);
  if (idResult._tag === "err") {
    throw userError(idResult.detail);
  }
  const id = idResult.value;
  if (isGlobal) {
    if (ctx.home === undefined) {
      throw userError("global configuration requires $HOME");
    }
    await runEffect(writeGlobalConfig(ctx.home, id));
  } else {
    const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
    if (root === undefined) {
      throw userError("not a Snap repository");
    }
    await runEffect(writeLocalConfig(root, id));
  }
  return emptyOut();
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export const runStatus = async (ctx: Ctx): Promise<Out> => {
  const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
  if (root === undefined) {
    throw userError("not a Snap repository");
  }
  const repo = await runEffect(requireRepository(root));
  const work = await runEffect(scanWorkingTree(root));
  const current = replayFrontier(repo);
  const entries = treeEntries(current, work);
  const version = formatVersion(repo.frontier);
  if (ctx.stdoutTerm) {
    let text = renderStatusHeader(version);
    if (entries.length === 0) {
      text += renderStatusClean();
    } else {
      for (const entry of entries) {
        const code = entry.oldBytes === undefined ? "A" : entry.newBytes === undefined ? "D" : "M";
        text += renderStatusRow(code, entry.path);
      }
    }
    return { ...emptyOut(), stdout: text };
  }
  let text = `version ${version}\n`;
  for (const entry of entries) {
    const code = entry.oldBytes === undefined ? "A" : entry.newBytes === undefined ? "D" : "M";
    text += `${code} ${entry.path}\n`;
  }
  return { ...emptyOut(), stdout: text };
};

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

export const runLog = async (ctx: Ctx): Promise<Out> => {
  const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
  if (root === undefined) {
    throw userError("not a Snap repository");
  }
  const repo = await runEffect(requireRepository(root));
  const orderResult = integrationOrder(repo.patches);
  if (orderResult._tag === "err") {
    throw userError("cyclic or incomplete patch history");
  }
  const reversed = [...orderResult.value].reverse();
  if (ctx.stdoutTerm) {
    const parts: string[] = [];
    for (const patch of reversed) {
      const resultV = nextFrontier(patch.base, patch.author);
      parts.push(
        renderLogEntry(escapeLogMessage(patch.message), formatVersion(resultV), patch.author),
      );
    }
    return { ...emptyOut(), stdout: parts.join("\n") };
  }
  let text = "";
  for (const patch of reversed) {
    const resultV = nextFrontier(patch.base, patch.author);
    text += `${formatVersion(resultV)}\t${patch.author}\t${escapeLogMessage(patch.message)}\n`;
  }
  return { ...emptyOut(), stdout: text };
};

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export const runCommit = async (ctx: Ctx, messageArg: string): Promise<Out> => {
  const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
  if (root === undefined) {
    throw userError("not a Snap repository");
  }
  const repo = await runEffect(requireRepository(root));
  const id = await runEffect(readContributorConfig(root, ctx.home));
  if (id === undefined) {
    throw userError("contributor.id is required; configure it locally or globally");
  }
  if (validateCommitMessage(messageArg)._tag === "err") {
    throw userError("invalid commit message");
  }
  const work = await runEffect(scanWorkingTree(root));
  const current = replayFrontier(repo);
  if (treesEqual(current, work)) {
    throw userError("working tree is clean");
  }
  const conflict = ensurePrefixFree(work);
  if (conflict._tag === "err") {
    throw userError(conflict.detail);
  }
  guardRevision(repo.frontier, id);
  const changes = changesForTrees(current, work);
  const patch = newPatch(repo.frontier, id, messageArg, changes);
  await runEffect(saveRepository(root, withPatch(repo, patch)));
  const version = formatVersion(nextFrontier(repo.frontier, id));
  return {
    ...emptyOut(),
    stdout: ctx.stdoutTerm ? renderSuccess("Committed", version) : `${version}\n`,
  };
};

const validateCommitMessage = (message: string): Result<string> => {
  if (message.length === 0 || utf8(message).byteLength > 4096) {
    return err("invalid commit message");
  }
  for (const ch of message) {
    const code = ch.codePointAt(0);
    if (code === undefined || code === 0x7f || (code < 0x20 && code !== 9 && code !== 10)) {
      return err("invalid commit message");
    }
  }
  return ok(message);
};

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export type DiffTarget =
  | { readonly mode: "work" }
  | {
      readonly mode: "versions";
      readonly oldArg: string;
      readonly newArg: string;
      readonly repo?: string;
    };

export const runDiff = (ctx: Ctx, target: DiffTarget): Promise<Out> =>
  target.mode === "work" ? diffWorking(ctx) : diffVersions(ctx, target);

const diffWorking = async (ctx: Ctx): Promise<Out> => {
  const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
  if (root === undefined) {
    throw userError("not a Snap repository");
  }
  const repo = await runEffect(requireRepository(root));
  const work = await runEffect(scanWorkingTree(root));
  const current = replayFrontier(repo);
  return renderDiff(ctx, current, work);
};

const diffVersions = async (
  ctx: Ctx,
  target: Extract<DiffTarget, { mode: "versions" }>,
): Promise<Out> => {
  const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
  if (root === undefined) {
    throw userError("not a Snap repository");
  }
  const local = await runEffect(requireRepository(root));

  const oldResult = parseVersion(target.oldArg);
  if (oldResult._tag === "err") {
    throw userError(oldResult.detail);
  }
  const oldV = oldResult.value;
  if (!isKnownVersion(local.patches, oldV)) {
    throw userError(`unknown version: ${formatVersion(oldV)}`);
  }

  let newRepo = local;
  if (target.repo !== undefined) {
    const operand = target.repo;
    newRepo = isRemoteOperand(operand)
      ? await runEffect(fetchRepository(operand))
      : await runEffect(requireRepository(resolveLocalPath(operand, ctx.cwd)));
  }
  const newResult = parseVersion(target.newArg);
  if (newResult._tag === "err") {
    throw userError(newResult.detail);
  }
  const newV = newResult.value;
  if (!isKnownVersion(newRepo.patches, newV)) {
    throw userError(`unknown version: ${formatVersion(newV)}`);
  }
  if (target.repo !== undefined) {
    const collision = findPatchCollisions(local.patches, newRepo.patches);
    if (collision !== undefined) {
      throw userError(
        `patch collision: ${collision.author} revision ${String(collision.revision)}`,
      );
    }
  }
  const oldTree = materializeVersion(local, oldV);
  const newTree = materializeVersion(newRepo, newV);
  return renderDiff(ctx, oldTree, newTree);
};

const materializeVersion = (repo: Repository, version: Version): Tree => {
  const result = replayVersion(repo.patches, version);
  if (result._tag === "err") {
    throw userError(`unknown version: ${formatVersion(version)}`);
  }
  return result.value.tree;
};

export const findPatchCollisions = (
  a: readonly Patch[],
  b: readonly Patch[],
): { readonly author: ContributorId; readonly revision: number } | undefined => {
  const byDot = new Map<string, Patch>();
  for (const patch of a) {
    byDot.set(dot(patch.author, patch.revision), patch);
  }
  for (const patch of b) {
    const existing = byDot.get(dot(patch.author, patch.revision));
    if (existing !== undefined && !patchEq(existing, patch)) {
      return { author: patch.author, revision: patch.revision };
    }
  }
  return undefined;
};

const dot = (author: ContributorId, revision: number): string =>
  `${author}\u0000${String(revision)}`;

const patchEq = (a: Patch, b: Patch): boolean =>
  JSON.stringify(patchCanonical(a)) === JSON.stringify(patchCanonical(b));

const patchCanonical = (p: Patch): unknown => ({
  author: p.author,
  revision: p.revision,
  base: p.base,
  message: p.message,
  changes: p.changes,
});

const renderDiff = (ctx: Ctx, oldTree: Tree, newTree: Tree): Out => {
  let stdout = "";
  for (const entry of treeEntries(oldTree, newTree)) {
    stdout += renderDiffEntry(ctx, entry.path, entry.oldBytes, entry.newBytes);
  }
  return { ...emptyOut(), stdout };
};

const renderDiffEntry = (
  ctx: Ctx,
  path: string,
  oldBytes: Uint8Array | undefined,
  newBytes: Uint8Array | undefined,
): string => {
  const binary =
    (oldBytes !== undefined && !isText(oldBytes)) || (newBytes !== undefined && !isText(newBytes));
  if (binary) {
    const left = oldBytes === undefined ? "/dev/null" : `a/${path}`;
    const right = newBytes === undefined ? "/dev/null" : `b/${path}`;
    const line = `Binary files ${left} and ${right} differ`;
    return ctx.stdoutTerm ? `${sgr(33, line)}\n` : `${line}\n`;
  }
  const oldTokens = oldBytes === undefined ? [] : tokenize(Buffer.from(oldBytes).toString("utf8"));
  const newTokens = newBytes === undefined ? [] : tokenize(Buffer.from(newBytes).toString("utf8"));
  const oldHeader = oldBytes === undefined ? "/dev/null" : `a/${path}`;
  const newHeader = newBytes === undefined ? "/dev/null" : `b/${path}`;
  const script = diffTokens(oldTokens, newTokens);
  const lines: string[] = [];
  lines.push(`--- ${oldHeader}`);
  lines.push(`+++ ${newHeader}`);
  lines.push(`@@ -1,${String(oldTokens.length)} +1,${String(newTokens.length)} @@`);
  let oi = 0;
  for (const op of script) {
    if ("retain" in op) {
      for (let k = 0; k < op.retain; k += 1) {
        pushDiffLine(lines, oldTokens[oi] as string, " ");
        oi += 1;
      }
    } else if ("delete" in op) {
      for (let k = 0; k < op.delete; k += 1) {
        pushDiffLine(lines, oldTokens[oi] as string, "-");
        oi += 1;
      }
    } else {
      for (const token of op.insert) {
        pushDiffLine(lines, token, "+");
      }
    }
  }
  let text = "";
  for (const line of lines) {
    if (ctx.stdoutTerm) {
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        text += sgr(1, line) + "\n";
      } else if (line.startsWith("@@ ")) {
        text += sgr(36, line) + "\n";
      } else if (line.startsWith("+")) {
        text += sgr(32, line) + "\n";
      } else if (line.startsWith("-") || line.startsWith("\\ ")) {
        text += sgr(line.startsWith("\\ ") ? 2 : 31, line) + "\n";
      } else {
        text += line + "\n";
      }
    } else {
      text += line + "\n";
    }
  }
  return text;
};

const pushDiffLine = (lines: string[], token: string, prefix: string): void => {
  const noLf = !token.endsWith("\n");
  lines.push(prefix + token.replace(/\n$/, ""));
  if (noLf) {
    lines.push("\\ No newline at end of file");
  }
};

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

export const runRevert = async (ctx: Ctx, versionArg: string): Promise<Out> => {
  const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
  if (root === undefined) {
    throw userError("not a Snap repository");
  }
  const repo = await runEffect(requireRepository(root));
  const versionResult = parseVersion(versionArg);
  if (versionResult._tag === "err") {
    throw userError(versionResult.detail);
  }
  const targetV = versionResult.value;
  if (!isKnownVersion(repo.patches, targetV)) {
    throw userError(`unknown version: ${formatVersion(targetV)}`);
  }
  const id = await runEffect(readContributorConfig(root, ctx.home));
  if (id === undefined) {
    throw userError("contributor.id is required; configure it locally or globally");
  }
  const work = await runEffect(scanWorkingTree(root));
  const current = replayFrontier(repo);
  if (!treesEqual(current, work)) {
    throw userError("working tree is dirty");
  }
  const target = materializeVersion(repo, targetV);
  if (treesEqual(current, target)) {
    throw userError("target tree is already current");
  }
  guardRevision(repo.frontier, id);
  const changes = changesForTrees(current, target);
  const message = `revert to ${formatVersion(targetV)}`;
  const patch = newPatch(repo.frontier, id, message, changes);
  await runEffect(materializeTree(root, target));
  await runEffect(saveRepository(root, withPatch(repo, patch)));
  const version = formatVersion(nextFrontier(repo.frontier, id));
  return {
    ...emptyOut(),
    stdout: ctx.stdoutTerm ? renderSuccess("Reverted", version) : `${version}\n`,
  };
};

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

export const runMerge = async (ctx: Ctx, operand: string): Promise<Out> => {
  const root: string | undefined = await runEffect(locateRepositoryRoot(ctx.cwd));
  if (root === undefined) {
    throw userError("not a Snap repository");
  }
  const local = await runEffect(requireRepository(root));
  const work = await runEffect(scanWorkingTree(root));
  const localCurrent = replayFrontier(local);
  if (!treesEqual(localCurrent, work)) {
    throw userError("working tree is dirty");
  }
  const remote = isRemoteOperand(operand)
    ? await runEffect(fetchRepository(operand))
    : await runEffect(requireRepository(resolveLocalPath(operand, ctx.cwd)));

  const collision = findPatchCollisions(local.patches, remote.patches);
  if (collision !== undefined) {
    throw userError(`patch collision: ${collision.author} revision ${String(collision.revision)}`);
  }

  const unionMap = new Map<string, Patch>();
  for (const patch of local.patches) {
    unionMap.set(dot(patch.author, patch.revision), patch);
  }
  for (const patch of remote.patches) {
    unionMap.set(dot(patch.author, patch.revision), patch);
  }
  const unionPatches = Array.from(unionMap.values()).sort((a, b) => {
    const byAuthor = compareTrackedPath(a.author, b.author);
    return byAuthor !== 0 ? byAuthor : a.revision - b.revision;
  });
  const joinedFrontier = joinVersions(local.frontier, remote.frontier);
  const joinedReplay = replayVersion(unionPatches, joinedFrontier);
  if (joinedReplay._tag === "err") {
    throw userError("cyclic or incomplete patch history");
  }

  const localWarnings = new Set<string>();
  const localReplay = replayVersion(local.patches, local.frontier);
  if (localReplay._tag === "ok") {
    for (const warning of localReplay.value.warnings) {
      localWarnings.add(`${warning.path}\u0000${warning.reason}`);
    }
  }
  let stderr = "";
  for (const warning of joinedReplay.value.warnings) {
    if (!localWarnings.has(`${warning.path}\u0000${warning.reason}`)) {
      const detail = `auto-resolved ${warning.path}: ${warning.reason}`;
      stderr += ctx.stderrTerm ? `${sgr(33, "⚠")} ${sgr(33, detail)}\n` : `warning: ${detail}\n`;
    }
  }

  const merged: Repository = { format: 1, frontier: joinedFrontier, patches: unionPatches };
  await runEffect(materializeTree(root, joinedReplay.value.tree));
  await runEffect(saveRepository(root, merged));
  const version = formatVersion(joinedFrontier);
  const stdout = ctx.stdoutTerm ? renderSuccess("Merged", version) : `${version}\n`;
  return { stdout, stderr };
};
