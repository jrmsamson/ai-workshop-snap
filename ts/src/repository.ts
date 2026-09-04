import { Effect } from "effect";

import { validateContributorId } from "./contributor.js";
import { SnapError, internalError, userError } from "./errors.js";
import { atomicWriteText, readTextFileIfExists } from "./fsutil.js";
import { parseJson } from "./json.js";
import { compareTrackedPath, validateTrackedPath } from "./path.js";
import { applyPatchToTree, decodeBase64 } from "./patch.js";
import { replayVersion } from "./replay.js";
import type {
  Change,
  ContributorId,
  ContributorRevision,
  EditOp,
  EditScript,
  Patch,
  Repository,
  Revision,
  TrackedPath,
  Version,
} from "./types.js";
import { err, ok, type Result } from "./types.js";

const MAX_SAFE = 9007199254740991;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSafePositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SAFE;

const isString = (value: unknown): value is string => typeof value === "string";

/** Messages may contain tab and LF but no other ASCII control character (§4.2). */
const validMessage = (message: string): boolean => {
  for (const ch of message) {
    const code = ch.codePointAt(0);
    if (code === undefined || code === 0x7f || (code < 0x20 && code !== 9 && code !== 10)) {
      return false;
    }
  }
  return true;
};

/** Validates a repository-JSON version array: canonical, distinct ids, positive safe revisions. */
const validateVersionArray = (value: unknown): Result<Version> => {
  if (!Array.isArray(value)) {
    return err("version must be an array");
  }
  const out: ContributorRevision[] = [];
  let previous: ContributorId | undefined;
  for (const element of value) {
    if (!Array.isArray(element) || element.length !== 2) {
      return err("version entry must be a two-element array");
    }
    const idValue = element[0] as unknown;
    if (!isString(idValue)) {
      return err("invalid contributor id");
    }
    const idResult = validateContributorId(idValue);
    if (idResult._tag === "err") {
      return idResult;
    }
    const revisionValue = element[1] as unknown;
    if (!isSafePositiveInt(revisionValue)) {
      return err("revision must be a positive safe integer");
    }
    if (previous !== undefined && compareTrackedPath(previous, idResult.value) >= 0) {
      return err("version is not canonical (ids must be sorted and distinct)");
    }
    out.push([idResult.value, revisionValue]);
    previous = idResult.value;
  }
  return ok(out);
};

/** Validates the edit-array structure of a text change. */
const validateEditOps = (value: unknown): Result<EditScript> => {
  if (!Array.isArray(value)) {
    return err("edit must be an array");
  }
  const ops: EditOp[] = [];
  let previousKind: string | undefined;
  for (const opValue of value) {
    if (!isObject(opValue)) {
      return err("edit operation must be an object");
    }
    const keys = Object.keys(opValue);
    const present = keys.filter((key) => key === "retain" || key === "delete" || key === "insert");
    if (present.length !== 1 || keys.length !== 1) {
      return err("edit op must have one operation");
    }
    const kind = present[0] as string;
    if (kind === "insert") {
      const insert = opValue["insert"];
      if (!Array.isArray(insert) || insert.length === 0) {
        return err("edit insert is empty");
      }
      for (const token of insert) {
        if (!isString(token) || token.length === 0) {
          return err("insert token must be a nonempty string");
        }
      }
      ops.push({ insert: insert as readonly string[] });
    } else {
      const count = opValue[kind];
      if (!isSafePositiveInt(count)) {
        return err(`${kind} count must be a positive safe integer`);
      }
      ops.push(kind === "retain" ? { retain: count } : { delete: count });
    }
    if (kind === previousKind) {
      return err(`adjacent ${kind}`);
    }
    previousKind = kind;
  }
  return ok(ops);
};

/** Validates one change object and returns the typed change. */
const validateChange = (value: unknown): Result<Change> => {
  if (!isObject(value)) {
    return err("change must be an object");
  }
  const typeValue = value["type"];
  if (typeValue !== "text" && typeValue !== "put" && typeValue !== "delete") {
    return err("change type must be text, put, or delete");
  }
  if (!isString(value["path"])) {
    return err("path is invalid");
  }
  const pathResult = validateTrackedPath(value["path"]);
  if (pathResult._tag === "err") {
    return pathResult;
  }
  const path = pathResult.value;
  if (typeValue === "text") {
    for (const key of Object.keys(value)) {
      if (key !== "type" && key !== "path" && key !== "edit") {
        return err(`change has unknown field: ${key}`);
      }
    }
    const editResult = validateEditOps(value["edit"]);
    if (editResult._tag === "err") {
      return editResult;
    }
    return ok({ type: "text", path, edit: editResult.value });
  }
  if (typeValue === "put") {
    for (const key of Object.keys(value)) {
      if (key !== "type" && key !== "path" && key !== "content") {
        return err(`change has unknown field: ${key}`);
      }
    }
    if (!isString(value["content"])) {
      return err("content must be a string");
    }
    const contentResult = decodeBase64(value["content"]);
    if (contentResult._tag === "err") {
      return contentResult;
    }
    return ok({ type: "put", path, content: value["content"] });
  }
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "path") {
      return err(`change has unknown field: ${key}`);
    }
  }
  return ok({ type: "delete", path });
};

/** Validates one patch object and returns the typed patch. */
const validatePatch = (value: unknown): Result<Patch> => {
  if (!isObject(value)) {
    return err("patch must be an object");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "author" &&
      key !== "revision" &&
      key !== "base" &&
      key !== "message" &&
      key !== "changes"
    ) {
      return err(`change has unknown field: ${key}`);
    }
  }
  if (!isString(value["author"])) {
    return err("invalid contributor id");
  }
  const authorResult = validateContributorId(value["author"]);
  if (authorResult._tag === "err") {
    return authorResult;
  }
  if (!isSafePositiveInt(value["revision"])) {
    return err("patch revision must be a positive safe integer");
  }
  const baseResult = validateVersionArray(value["base"]);
  if (baseResult._tag === "err") {
    return baseResult;
  }
  if (!isString(value["message"])) {
    return err("message must be a string");
  }
  if (value["message"].length === 0) {
    return err("patch message is empty");
  }
  if (!validMessage(value["message"])) {
    return err("patch message contains an invalid control character");
  }
  if (!Array.isArray(value["changes"])) {
    return err("changes must be an array");
  }
  if (value["changes"].length === 0) {
    return err("patch changes is empty");
  }
  const changes: Change[] = [];
  let previousPath: TrackedPath | undefined;
  for (const changeValue of value["changes"]) {
    const changeResult = validateChange(changeValue);
    if (changeResult._tag === "err") {
      return changeResult;
    }
    if (
      previousPath !== undefined &&
      compareTrackedPath(previousPath, changeResult.value.path) >= 0
    ) {
      return err("changes must be sorted by path with no duplicates");
    }
    changes.push(changeResult.value);
    previousPath = changeResult.value.path;
  }
  return ok({
    author: authorResult.value,
    revision: value["revision"],
    base: baseResult.value,
    message: value["message"],
    changes,
  });
};

/** Validates the parsed repository value (§4.5) into a typed Repository. */
export const validateRepositoryJson = (value: unknown): Result<Repository> => {
  if (!isObject(value)) {
    return err("repository must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "format" && key !== "frontier" && key !== "patches") {
      return err(`repository has unknown field: ${key}`);
    }
  }
  if (value["format"] !== 1) {
    return err("unsupported repository format");
  }
  const frontierResult = validateVersionArray(value["frontier"]);
  if (frontierResult._tag === "err") {
    return frontierResult;
  }
  if (!Array.isArray(value["patches"])) {
    return err("patches must be an array");
  }
  const patches: Patch[] = [];
  let previousAuthor: ContributorId | undefined;
  let previousRevision: Revision | undefined;
  for (const patchValue of value["patches"]) {
    const patchResult = validatePatch(patchValue);
    if (patchResult._tag === "err") {
      return patchResult;
    }
    if (
      previousAuthor !== undefined &&
      previousRevision !== undefined &&
      (compareTrackedPath(previousAuthor, patchResult.value.author) > 0 ||
        (compareTrackedPath(previousAuthor, patchResult.value.author) === 0 &&
          previousRevision >= patchResult.value.revision))
    ) {
      return err("patches must be sorted by author and revision");
    }
    previousAuthor = patchResult.value.author;
    previousRevision = patchResult.value.revision;
    patches.push(patchResult.value);
  }
  const semantic = semanticValidate(patches, frontierResult.value);
  if (semantic._tag === "err") {
    return semantic;
  }
  return ok({ format: 1, frontier: frontierResult.value, patches });
};

/** §4.5 semantic checks over the typed patches + frontier. */
const semanticValidate = (patches: readonly Patch[], frontier: Version): Result<void> => {
  const byAuthor = new Map<ContributorId, Map<Revision, Patch>>();
  for (const patch of patches) {
    let byRev = byAuthor.get(patch.author);
    if (byRev === undefined) {
      byRev = new Map();
      byAuthor.set(patch.author, byRev);
    }
    byRev.set(patch.revision, patch);
  }

  // Reachability + revision contiguity from the frontier.
  const required: Patch[] = [];
  for (const [id, counter] of frontier) {
    for (let revision = 1; revision <= counter; revision += 1) {
      const match = byAuthor.get(id)?.get(revision);
      if (match === undefined) {
        return err(`missing ${id} revision ${String(revision)}`);
      }
      required.push(match);
    }
  }
  if (required.length !== patches.length) {
    const unreachable = patches.find((patch) => !required.includes(patch));
    if (unreachable !== undefined) {
      return err(`unreachable patch: ${unreachable.author} ${String(unreachable.revision)}`);
    }
    return err("unreachable patch");
  }

  // Dot arithmetic: revision = base[author] + 1 (§4.2).
  for (const patch of required) {
    const baseValue = patch.base.find(([id]) => id === patch.author)?.[1] ?? 0;
    if (baseValue + 1 !== patch.revision) {
      return err("patch revision does not follow its base");
    }
  }

  // Cycle detection over required patches (Kahn).
  const byDot = new Map<string, Patch>();
  for (const patch of required) {
    byDot.set(dotKey(patch.author, patch.revision), patch);
  }
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const patch of required) {
    indegree.set(dotKey(patch.author, patch.revision), 0);
  }
  for (const patch of required) {
    const key = dotKey(patch.author, patch.revision);
    for (const [id, revision] of patch.base) {
      const dep = byDot.get(dotKey(id, revision));
      if (dep !== undefined) {
        const depKey = dotKey(dep.author, dep.revision);
        let set = dependents.get(depKey);
        if (set === undefined) {
          set = new Set();
          dependents.set(depKey, set);
        }
        if (!set.has(key)) {
          set.add(key);
          indegree.set(key, (indegree.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const queue: string[] = [];
  for (const [key, degree] of indegree) {
    if (degree === 0) {
      queue.push(key);
    }
  }
  let visited = 0;
  while (queue.length > 0) {
    const key = queue.pop() as string;
    visited += 1;
    for (const next of dependents.get(key) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
      }
    }
  }
  if (visited !== required.length) {
    return err("cyclic or incomplete patch history");
  }

  // Every change against its materialized exact base (§4.5 step 5).
  for (const patch of required) {
    const baseReplay = replayVersion(patches, patch.base);
    if (baseReplay._tag === "err") {
      return err("cyclic or incomplete patch history");
    }
    const authored = applyPatchToTree(patch, baseReplay.value.tree);
    if (authored._tag === "err") {
      return authored;
    }
  }

  // Deterministic replay of the declared frontier (§4.5 step 6).
  if (replayVersion(patches, frontier)._tag === "err") {
    return err("cyclic or incomplete patch history");
  }
  return ok(undefined);
};

const dotKey = (author: ContributorId, revision: Revision): string =>
  `${author}\u0000${String(revision)}`;

/** §4.1: a version is known when its selected patch set is complete and closed. */
export const isKnownVersion = (patches: readonly Patch[], version: Version): boolean => {
  const byDot = new Map<string, Patch>();
  for (const patch of patches) {
    byDot.set(dotKey(patch.author, patch.revision), patch);
  }
  for (const [id, counter] of version) {
    for (let revision = 1; revision <= counter; revision += 1) {
      if (!byDot.has(dotKey(id, revision))) {
        return false;
      }
    }
  }
  return replayVersion(patches, version)._tag === "ok";
};

/** Canonical serialization (SPEC §4.1): fixed key order, two-space JSON, trailing LF. */
export const serializeRepository = (repo: Repository): string => {
  const root = {
    format: 1,
    frontier: repo.frontier.map(([id, revision]) => [id, revision]),
    patches: repo.patches.map((patch) => ({
      author: patch.author,
      revision: patch.revision,
      base: patch.base.map(([id, revision]) => [id, revision]),
      message: patch.message,
      changes: patch.changes.map(serializeChange),
    })),
  };
  return `${JSON.stringify(root, null, 2)}\n`;
};

const serializeChange = (change: Change): unknown => {
  if (change.type === "text") {
    return { type: "text", path: change.path, edit: change.edit };
  }
  if (change.type === "put") {
    return { type: "put", path: change.path, content: change.content };
  }
  return { type: "delete", path: change.path };
};

const repositoryFilePath = (root: string): string => `${root}/.snap/repository.json`;

export const readRepositoryJson = (
  root: string,
): Effect.Effect<Repository | undefined, SnapError> =>
  Effect.flatMap(readTextFileIfExists(repositoryFilePath(root)), (text) => {
    if (text === undefined) {
      return Effect.succeed(undefined);
    }
    const parsed = parseJson(text);
    if (parsed._tag === "err") {
      return Effect.fail(userError(parsed.detail));
    }
    const validated = validateRepositoryJson(parsed.value);
    if (validated._tag === "err") {
      return Effect.fail(userError(validated.detail));
    }
    return Effect.succeed(validated.value);
  });

export const saveRepository = (root: string, repo: Repository): Effect.Effect<void, SnapError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(`${root}/.snap`, { recursive: true });
      },
      catch: (cause) => internalError(`cannot create .snap directory: ${String(cause)}`),
    }),
    () => atomicWriteText(repositoryFilePath(root), serializeRepository(repo)),
  );
