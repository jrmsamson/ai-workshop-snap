import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";

import {
  ChangeSchema,
  ContributorConfigSchema,
  decodeContributorConfig,
  RepositorySchema,
  VersionSchema,
} from "./schema.js";

const canonicalRepository = {
  format: 1,
  frontier: [["alice@example.com", 1]],
  patches: [
    {
      author: "alice@example.com",
      revision: 1,
      base: [],
      message: "add greeting",
      changes: [
        {
          type: "text",
          path: "hello.txt",
          edit: [{ insert: ["hello\n"] }],
        },
      ],
    },
  ],
};

void describe("decodeContributorConfig", () => {
  void it("accepts exactly {contributor:{id}}", () => {
    const result = decodeContributorConfig({ contributor: { id: "a@x" } });
    assert.equal(result._tag, "ok");
    assert.deepEqual(result.value, { contributor: { id: "a@x" } });
  });

  void it("accepts any string id spelling (shape-only here)", () => {
    const result = decodeContributorConfig({ contributor: { id: "not an id" } });
    assert.equal(result._tag, "ok");
  });

  void it("rejects a missing contributor block", () => {
    const result = decodeContributorConfig({});
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "invalid config file");
  });

  void it("rejects a missing id", () => {
    const result = decodeContributorConfig({ contributor: {} });
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "invalid config file");
  });

  void it("rejects an id that is not a string", () => {
    const result = decodeContributorConfig({ contributor: { id: 5 } });
    assert.equal(result._tag, "err");
    assert.equal(result.detail, "invalid config file");
  });

  void it("rejects excess keys at both levels", () => {
    const outer = decodeContributorConfig({ contributor: { id: "a@x" }, extra: 1 });
    assert.equal(outer._tag, "err");
    assert.equal(outer.detail, "invalid config file");
    const inner = decodeContributorConfig({ contributor: { id: "a@x", extra: 1 } });
    assert.equal(inner._tag, "err");
    assert.equal(inner.detail, "invalid config file");
  });

  void it("rejects non-object input", () => {
    for (const value of [null, [], "config", 3]) {
      const result = decodeContributorConfig(value);
      assert.equal(result._tag, "err", `expected ${JSON.stringify(value)} to be rejected`);
    }
  });
});

void describe("RepositorySchema", () => {
  void it("accepts the canonical SPEC §4.1 repository", () => {
    const decoded = Schema.decodeUnknownSync(RepositorySchema)(canonicalRepository);
    assert.deepEqual(decoded, canonicalRepository);
  });

  void it("rejects a wrong format literal", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(RepositorySchema)({ ...canonicalRepository, format: 2 }),
    );
  });

  void it("rejects a non-integer revision", () => {
    const fractional = {
      format: 1,
      frontier: [["alice@example.com", 1]],
      patches: [
        {
          author: "alice@example.com",
          revision: 1.5,
          base: [],
          message: "add greeting",
          changes: [
            {
              type: "text",
              path: "hello.txt",
              edit: [{ insert: ["hello\n"] }],
            },
          ],
        },
      ],
    };
    assert.throws(() => Schema.decodeUnknownSync(RepositorySchema)(fractional));
  });
});

void describe("documentation schemas", () => {
  void it("decodes a version of contributor revisions", () => {
    const decoded = Schema.decodeUnknownSync(VersionSchema)([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    assert.deepEqual(decoded, [
      ["a@x", 1],
      ["b@x", 2],
    ]);
  });

  void it("rejects a fractional revision in a version", () => {
    assert.throws(() => Schema.decodeUnknownSync(VersionSchema)([["a@x", 1.5]]));
  });

  void it("decodes each change variant", () => {
    const decoded = Schema.decodeUnknownSync(ChangeSchema)({
      type: "put",
      path: "f",
      content: "YQ==",
    });
    assert.deepEqual(decoded, { type: "put", path: "f", content: "YQ==" });
  });

  void it("rejects a change without a known type tag", () => {
    assert.throws(() => Schema.decodeUnknownSync(ChangeSchema)({ type: "move", path: "f" }));
  });

  void it("documents the config contributor id as a string", () => {
    const decoded = Schema.decodeUnknownSync(ContributorConfigSchema)({
      contributor: { id: "a@x" },
    });
    assert.deepEqual(decoded, { contributor: { id: "a@x" } });
  });
});
