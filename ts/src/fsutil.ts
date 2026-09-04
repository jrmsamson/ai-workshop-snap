import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { internalError, type SnapError } from "./errors.js";
import type { Tree } from "./types.js";

const describeError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  return "unknown error";
};

const fsFailure = (op: string, target: string, err: unknown): SnapError =>
  internalError(`${op} on ${target} failed: ${describeError(err)}`);

const errorCode = (err: unknown): string | undefined => {
  if (typeof err === "object" && err !== null && "code" in err) {
    return typeof err.code === "string" ? err.code : undefined;
  }
  return undefined;
};

const isCode = (err: unknown, codes: readonly string[]): boolean => {
  const code = errorCode(err);
  return code !== undefined && codes.includes(code);
};

const isEnoent = (err: unknown): boolean => isCode(err, ["ENOENT"]);

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: run,
    catch: (err) => err,
  });

export const readTextFile = (filePath: string): Effect.Effect<string, SnapError> =>
  attempt(() => fs.readFile(filePath, "utf8")).pipe(
    Effect.catchAll((err) => Effect.fail(fsFailure("readTextFile", filePath, err))),
  );

export const readTextFileIfExists = (
  filePath: string,
): Effect.Effect<string | undefined, SnapError> =>
  attempt(() => fs.readFile(filePath, "utf8")).pipe(
    Effect.matchEffect({
      onFailure: (err) =>
        isEnoent(err)
          ? Effect.succeed(undefined)
          : Effect.fail(fsFailure("readTextFile", filePath, err)),
      onSuccess: (content) => Effect.succeed(content),
    }),
  );

const lstatIfExists = (p: string): Effect.Effect<Stats | undefined, SnapError> =>
  attempt(() => fs.lstat(p)).pipe(
    Effect.matchEffect({
      onFailure: (err) =>
        isEnoent(err) ? Effect.succeed(undefined) : Effect.fail(fsFailure("lstat", p, err)),
      onSuccess: (stats) => Effect.succeed(stats),
    }),
  );

export const fileExists = (p: string): Effect.Effect<boolean, SnapError> =>
  Effect.map(lstatIfExists(p), (stats) => stats !== undefined);

export const ensureDir = (p: string): Effect.Effect<void, SnapError> =>
  Effect.gen(function* () {
    const stats = yield* lstatIfExists(p);
    if (stats === undefined) {
      yield* attempt(() => fs.mkdir(p, { recursive: true })).pipe(
        Effect.catchAll((err) => Effect.fail(fsFailure("mkdir", p, err))),
      );
      return;
    }
    if (!stats.isDirectory()) {
      yield* Effect.fail(fsFailure("mkdir", p, new Error("path exists and is not a directory")));
    }
  });

export const removeTree = (p: string): Effect.Effect<void, SnapError> =>
  attempt(() => fs.rm(p, { recursive: true, force: true })).pipe(
    Effect.catchAll((err) => Effect.fail(fsFailure("removeTree", p, err))),
  );

const unlinkIfPresent = (p: string): Effect.Effect<void, SnapError> =>
  attempt(() => fs.unlink(p)).pipe(
    Effect.matchEffect({
      onFailure: (err) => (isEnoent(err) ? Effect.void : Effect.fail(fsFailure("unlink", p, err))),
      onSuccess: () => Effect.void,
    }),
  );

const unlinkBestEffort = (p: string): Effect.Effect<void> =>
  attempt(() => fs.unlink(p)).pipe(Effect.orElse(() => Effect.void));

const rmdirIfEmpty = (p: string): Effect.Effect<void, SnapError> =>
  attempt(() => fs.rmdir(p)).pipe(
    Effect.matchEffect({
      onFailure: (err) =>
        isCode(err, ["ENOENT", "ENOTEMPTY", "ENOTDIR", "EEXIST"])
          ? Effect.void
          : Effect.fail(fsFailure("rmdir", p, err)),
      onSuccess: () => Effect.void,
    }),
  );

export const atomicWriteFile = (
  filePath: string,
  data: Uint8Array,
): Effect.Effect<void, SnapError> =>
  Effect.gen(function* () {
    const dir = path.dirname(filePath);
    const temp = path.join(
      dir,
      `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    const replace = Effect.gen(function* () {
      yield* attempt(() => fs.writeFile(temp, data, { flag: "wx" })).pipe(
        Effect.catchAll((err) => Effect.fail(fsFailure("writeFile", temp, err))),
      );
      yield* attempt(() => fs.rename(temp, filePath)).pipe(
        Effect.catchAll((err) => Effect.fail(fsFailure("rename", temp, err))),
      );
    });
    yield* replace.pipe(
      Effect.catchAll((err) => unlinkBestEffort(temp).pipe(Effect.andThen(Effect.fail(err)))),
    );
  });

export const atomicWriteText = (filePath: string, text: string): Effect.Effect<void, SnapError> =>
  atomicWriteFile(filePath, Buffer.from(text, "utf8"));

const comparePaths = (a: string, b: string): number => {
  const bytesA = Buffer.from(a, "utf8");
  const bytesB = Buffer.from(b, "utf8");
  return Buffer.compare(bytesA, bytesB);
};

const ensureDirectory = (p: string): Effect.Effect<void, SnapError> =>
  Effect.gen(function* () {
    const stats = yield* lstatIfExists(p);
    if (stats !== undefined && stats.isDirectory()) {
      return;
    }
    if (stats !== undefined) {
      yield* removeTree(p);
    }
    yield* attempt(() => fs.mkdir(p)).pipe(
      Effect.catchAll((err) => Effect.fail(fsFailure("mkdir", p, err))),
    );
  });

const prepareFileTarget = (p: string): Effect.Effect<void, SnapError> =>
  Effect.gen(function* () {
    const stats = yield* lstatIfExists(p);
    if (stats === undefined) {
      return;
    }
    if (stats.isDirectory()) {
      yield* removeTree(p);
      return;
    }
    if (!stats.isFile()) {
      yield* unlinkIfPresent(p);
    }
  });

const writeDesiredFile = (
  root: string,
  rel: string,
  bytes: Uint8Array,
): Effect.Effect<void, SnapError> => {
  const segments = rel.split("/");
  return Effect.gen(function* () {
    for (let i = 0; i < segments.length - 1; i++) {
      yield* ensureDirectory(path.join(root, ...segments.slice(0, i + 1)));
    }
    const target = path.join(root, ...segments);
    yield* prepareFileTarget(target);
    yield* attempt(() => fs.writeFile(target, bytes)).pipe(
      Effect.catchAll((err) => Effect.fail(fsFailure("writeFile", target, err))),
    );
  });
};

const readdirSorted = (dir: string): Effect.Effect<readonly Dirent[], SnapError> =>
  attempt(() => fs.readdir(dir, { withFileTypes: true })).pipe(
    Effect.map((entries) =>
      [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ),
    Effect.catchAll((err) => Effect.fail(fsFailure("readdir", dir, err))),
  );

const pruneTree = (
  dir: string,
  relDir: string,
  desired: ReadonlySet<string>,
): Effect.Effect<void, SnapError> =>
  Effect.gen(function* () {
    const entries = yield* readdirSorted(dir);
    for (const entry of entries) {
      const name = entry.name;
      const childPath = path.join(dir, name);
      const childRel = relDir === "" ? name : `${relDir}/${name}`;
      if (relDir === "" && name === ".snap") {
        continue;
      }
      if (entry.isDirectory()) {
        yield* pruneTree(childPath, childRel, desired);
      } else if (!desired.has(childRel)) {
        yield* unlinkIfPresent(childPath);
      }
    }
    if (relDir !== "") {
      yield* rmdirIfEmpty(dir);
    }
  });

export const materializeTree = (root: string, tree: Tree): Effect.Effect<void, SnapError> =>
  Effect.gen(function* () {
    yield* ensureDir(root);
    const ordered = [...tree.entries()].sort(([a], [b]) => comparePaths(a, b));
    for (const [rel, bytes] of ordered) {
      yield* writeDesiredFile(root, rel, bytes);
    }
    yield* pruneTree(root, "", new Set(tree.keys()));
  });
