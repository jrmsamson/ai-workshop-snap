import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { Effect, Either } from "effect";
import * as config from "./config.js";
import { type SnapError } from "./errors.js";

const run = <A>(effect: Effect.Effect<A, SnapError>): Promise<A> => Effect.runPromise(effect);

const leftError = async (effect: Effect.Effect<unknown, SnapError>): Promise<SnapError> => {
  const either = await Effect.runPromise(Effect.either(effect));
  assert.ok(Either.isLeft(either), "expected the effect to fail");
  return either.left;
};

const tempDir = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "snap-config-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
};

const readText = async (p: string): Promise<string> => readFile(p, "utf8");

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
};

const writeText = async (filePath: string, text: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
};

void test("configFilePath and globalConfigFilePath locate the two config files", () => {
  assert.equal(config.configFilePath("/repo"), "/repo/.snap/config.json");
  assert.equal(config.globalConfigFilePath("/home/u"), "/home/u/.snapconfig.json");
});

void test("writeLocalConfig creates .snap and writes exact canonical bytes, overwriting cleanly", async (t) => {
  const root = await tempDir(t);
  const localPath = config.configFilePath(root);

  await run(config.writeLocalConfig(root, "local@example.com"));
  assert.equal(
    await readText(localPath),
    '{\n  "contributor": {\n    "id": "local@example.com"\n  }\n}\n',
  );

  await run(config.writeLocalConfig(root, "new@example.com"));
  assert.equal(
    await readText(localPath),
    '{\n  "contributor": {\n    "id": "new@example.com"\n  }\n}\n',
  );
});

void test("writeGlobalConfig writes exact canonical bytes to the home file", async (t) => {
  const home = await tempDir(t);

  await run(config.writeGlobalConfig(home, "global@example.com"));
  assert.equal(
    await readText(config.globalConfigFilePath(home)),
    '{\n  "contributor": {\n    "id": "global@example.com"\n  }\n}\n',
  );
});

void test("a local id wins over the global config and over a broken global file", async (t) => {
  const root = await tempDir(t);
  const home = await tempDir(t);
  await run(config.writeLocalConfig(root, "local@example.com"));
  await writeJson(config.globalConfigFilePath(home), { contributor: { id: "global@example.com" } });

  assert.equal(await run(config.readContributorConfig(root, home)), "local@example.com");

  await writeText(config.globalConfigFilePath(home), "not json");
  assert.equal(await run(config.readContributorConfig(root, home)), "local@example.com");
});

void test("an empty-object local config falls back to the global config", async (t) => {
  const root = await tempDir(t);
  const home = await tempDir(t);
  await writeJson(config.configFilePath(root), {});
  await writeJson(config.globalConfigFilePath(home), { contributor: { id: "global@example.com" } });

  assert.equal(await run(config.readContributorConfig(root, home)), "global@example.com");
});

void test("a malformed global config errors when read and the local config is absent", async (t) => {
  const root = await tempDir(t);
  const home = await tempDir(t);
  await writeText(config.globalConfigFilePath(home), "not json");

  const snapError = await leftError(config.readContributorConfig(root, home));
  assert.equal(snapError.code, 1);
  assert.match(snapError.detail, /^invalid JSON/);
});

void test("an invalid local id errors and blocks the valid global config", async (t) => {
  const root = await tempDir(t);
  const home = await tempDir(t);
  await writeJson(config.configFilePath(root), { contributor: { id: "not-an-id" } });
  await writeJson(config.globalConfigFilePath(home), { contributor: { id: "global@example.com" } });

  const snapError = await leftError(config.readContributorConfig(root, home));
  assert.equal(snapError.code, 1);
  assert.equal(snapError.detail, "invalid contributor id: not-an-id");
});

void test("duplicate JSON keys and unknown or malformed fields are config errors", async (t) => {
  const root = await tempDir(t);
  const home = await tempDir(t);

  await writeText(config.configFilePath(root), '{"contributor":{"id":"a@x","id":"b@x"}}');
  assert.match(
    (await leftError(config.readContributorConfig(root, home))).detail,
    /^duplicate JSON key /,
  );

  await writeJson(config.configFilePath(root), { contributor: { id: "a@x" }, unknown: true });
  assert.equal(
    (await leftError(config.readContributorConfig(root, home))).detail,
    "invalid config file",
  );

  await writeJson(config.configFilePath(root), { id: "a@x" });
  assert.equal(
    (await leftError(config.readContributorConfig(root, home))).detail,
    "invalid config file",
  );

  await writeJson(config.configFilePath(root), { contributor: { id: "a@x", extra: 1 } });
  assert.equal(
    (await leftError(config.readContributorConfig(root, home))).detail,
    "invalid config file",
  );

  await writeJson(config.configFilePath(root), { contributor: {} });
  assert.equal(
    (await leftError(config.readContributorConfig(root, home))).detail,
    "invalid config file",
  );

  await writeJson(config.configFilePath(root), { contributor: { id: "" } });
  assert.equal(
    (await leftError(config.readContributorConfig(root, home))).detail,
    "invalid config file",
  );

  await writeJson(config.configFilePath(root), { contributor: { id: 7 } });
  assert.equal(
    (await leftError(config.readContributorConfig(root, home))).detail,
    "invalid config file",
  );

  await writeJson(config.configFilePath(root), ["not-an-object"]);
  assert.equal(
    (await leftError(config.readContributorConfig(root, home))).detail,
    "invalid config file",
  );
});

void test("a missing HOME makes global configuration unavailable", async (t) => {
  const root = await tempDir(t);
  assert.equal(await run(config.readContributorConfig(root, undefined)), undefined);
});

void test("absent local and global config files read as no value", async (t) => {
  const root = await tempDir(t);
  const home = await tempDir(t);
  assert.equal(await run(config.readContributorConfig(root, home)), undefined);
});
