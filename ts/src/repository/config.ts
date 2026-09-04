import { Effect } from "effect";

import { validateContributorId } from "../core/contributor.js";
import { internalError, type SnapError, userError } from "../core/errors.js";
import { atomicWriteText, readTextFileIfExists } from "./fsutil.js";
import { parseJson } from "../format/json.js";
import type { ContributorId, Result } from "../core/types.js";
import { err, ok } from "../core/types.js";

export const configFilePath = (root: string): string => `${root}/.snap/config.json`;

export const globalConfigFilePath = (home: string): string => `${home}/.snapconfig.json`;

const serializeConfig = (id: ContributorId): string =>
  `${JSON.stringify({ contributor: { id } }, null, 2)}\n`;

const ensureLocalConfigDir = (root: string): Effect.Effect<void, SnapError> =>
  Effect.tryPromise({
    try: async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(`${root}/.snap`, { recursive: true });
    },
    catch: (cause) => internalError(`cannot create .snap directory: ${String(cause)}`),
  });

export const writeLocalConfig = (root: string, id: ContributorId): Effect.Effect<void, SnapError> =>
  Effect.flatMap(ensureLocalConfigDir(root), () =>
    atomicWriteText(configFilePath(root), serializeConfig(id)),
  );

export const writeGlobalConfig = (
  home: string,
  id: ContributorId,
): Effect.Effect<void, SnapError> =>
  atomicWriteText(globalConfigFilePath(home), serializeConfig(id));

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const decodeConfigValue = (value: unknown): Result<ContributorId | undefined> => {
  if (!isObject(value)) {
    return err("invalid config file");
  }
  const topKeys = Object.keys(value);
  if (topKeys.length === 0) {
    return ok(undefined);
  }
  for (const key of topKeys) {
    if (key !== "contributor") {
      return err("invalid config file");
    }
  }
  const contributor = value["contributor"];
  if (!isObject(contributor)) {
    return err("invalid config file");
  }
  const contributorKeys = Object.keys(contributor);
  if (contributorKeys.length !== 1 || contributorKeys[0] !== "id") {
    return err("invalid config file");
  }
  const idValue = contributor["id"];
  if (typeof idValue !== "string" || idValue.length === 0) {
    return err("invalid config file");
  }
  const idResult = validateContributorId(idValue);
  if (idResult._tag === "err") {
    return err(idResult.detail);
  }
  return ok(idResult.value);
};

const readIdFromFile = (filePath: string): Effect.Effect<ContributorId | undefined, SnapError> =>
  Effect.flatMap(readTextFileIfExists(filePath), (text) => {
    if (text === undefined) {
      return Effect.succeed(undefined);
    }
    const parsed = parseJson(text);
    if (parsed._tag === "err") {
      return Effect.fail(userError(parsed.detail));
    }
    const decoded = decodeConfigValue(parsed.value);
    if (decoded._tag === "err") {
      return Effect.fail(userError(decoded.detail));
    }
    return Effect.succeed(decoded.value);
  });

export const readContributorConfig = (
  root: string,
  home: string | undefined,
): Effect.Effect<ContributorId | undefined, SnapError> =>
  Effect.flatMap(readIdFromFile(configFilePath(root)), (localId) => {
    if (localId !== undefined) {
      return Effect.succeed(localId);
    }
    if (home === undefined) {
      return Effect.succeed(undefined);
    }
    return readIdFromFile(globalConfigFilePath(home));
  });

export const contributorRequiredError = (): string =>
  "contributor.id is required; configure it locally or globally";
