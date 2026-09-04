import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";

import {
  readRepositoryJson,
  saveRepository,
  serializeRepository,
  validateRepositoryJson,
} from "./repository.js";
import type { Repository } from "./types.js";

const unwrap = <A>(result: { _tag: "ok"; value: A } | { _tag: "err"; detail: string }): A => {
  if (result._tag === "err") {
    assert.fail(`unexpected error: ${result.detail}`);
  }
  return result.value;
};

const expectInvalid = (value: unknown, substring: string): void => {
  const result = validateRepositoryJson(value);
  if (result._tag === "ok") {
    assert.fail(`expected validation error containing "${substring}"`);
  }
  assert.ok(
    result.detail.includes(substring),
    `detail "${result.detail}" should contain "${substring}"`,
  );
};

const validRepo = (): Record<string, unknown> => ({
  format: 1,
  frontier: [],
  patches: [],
});

const patch = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  author: "a@x",
  revision: 1,
  base: [],
  message: "m",
  changes: [{ type: "put", path: "f", content: "YQ==" }],
  ...overrides,
});

void test("accepts an empty repository", () => {
  unwrap(validateRepositoryJson(validRepo()));
});

void test("repository has unknown field", () => {
  expectInvalid({ ...validRepo(), unknown: true }, "repository has unknown field: unknown");
});

void test("frontier must be canonical", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [
        ["b@x", 1],
        ["a@x", 1],
      ],
      patches: [],
    },
    "canonical",
  );
});

void test("revision must be a positive safe integer", () => {
  expectInvalid(
    { format: 1, frontier: [["a@x", 1]], patches: [{ ...patch(), revision: 1.5 }] },
    "positive safe integer",
  );
});

void test("unreachable patch", () => {
  expectInvalid({ format: 1, frontier: [], patches: [patch()] }, "unreachable patch: a@x 1");
});

void test("message is empty", () => {
  expectInvalid(
    { format: 1, frontier: [["a@x", 1]], patches: [{ ...patch(), message: "" }] },
    "message is empty",
  );
});

void test("changes is empty", () => {
  expectInvalid(
    { format: 1, frontier: [["a@x", 1]], patches: [{ ...patch(), changes: [] }] },
    "changes is empty",
  );
});

void test("change unknown field", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [{ ...patch(), changes: [{ type: "put", path: "f", content: "YQ==", extra: 1 }] }],
    },
    "unknown field: extra",
  );
});

void test("edit op must have one operation", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        { ...patch(), changes: [{ type: "text", path: "f", edit: [{ retain: 1, delete: 1 }] }] },
      ],
    },
    "must have one operation",
  );
});

void test("zero count is a positive safe integer violation", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [{ ...patch(), changes: [{ type: "text", path: "f", edit: [{ retain: 0 }] }] }],
    },
    "positive safe integer",
  );
});

void test("insert is empty", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [{ ...patch(), changes: [{ type: "text", path: "f", edit: [{ insert: [] }] }] }],
    },
    "edit insert is empty",
  );
});

void test("adjacent insert ops are invalid", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          ...patch(),
          changes: [{ type: "text", path: "f", edit: [{ insert: ["a\n"] }, { insert: ["b\n"] }] }],
        },
      ],
    },
    "adjacent insert",
  );
});

void test("canonical base64 required for put content", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [{ ...patch(), changes: [{ type: "put", path: "f", content: "abc" }] }],
    },
    "canonical base64",
  );
});

void test("path is invalid", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [{ ...patch(), changes: [{ type: "put", path: ".snap/secret", content: "YQ==" }] }],
    },
    "path is invalid",
  );
});

void test("missing contributor revision", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 2]],
      patches: [{ ...patch({ revision: 2, base: [["a@x", 1]] }) }],
    },
    "missing a@x revision 1",
  );
});

void test("no-op change is invalid", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 2]],
      patches: [patch({ revision: 1 }), patch({ revision: 2, base: [["a@x", 1]] })],
    },
    "no-op change",
  );
});

void test("cyclic history is rejected", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [
        ["a@x", 1],
        ["b@x", 1],
      ],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [["b@x", 1]],
          message: "a",
          changes: [{ type: "put", path: "a", content: "YQ==" }],
        },
        {
          author: "b@x",
          revision: 1,
          base: [["a@x", 1]],
          message: "b",
          changes: [{ type: "put", path: "b", content: "Yg==" }],
        },
      ],
    },
    "cyclic or incomplete patch history",
  );
});

void test("patches must be sorted", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [
        ["a@x", 1],
        ["b@x", 1],
      ],
      patches: [
        {
          author: "b@x",
          revision: 1,
          base: [],
          message: "b",
          changes: [{ type: "put", path: "b", content: "Yg==" }],
        },
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "a",
          changes: [{ type: "put", path: "a", content: "YQ==" }],
        },
      ],
    },
    "patches must be sorted",
  );
});

void test("over-consuming delete is rejected", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [
        ["a@x", 1],
        ["b@x", 1],
      ],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "base",
          changes: [{ type: "text", path: "f", edit: [{ insert: ["one\n"] }] }],
        },
        {
          author: "b@x",
          revision: 1,
          base: [["a@x", 1]],
          message: "over",
          changes: [{ type: "text", path: "f", edit: [{ delete: 2 }] }],
        },
      ],
    },
    "consumes beyond old content",
  );
});

void test("delete of absent path", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [
        ["a@x", 1],
        ["b@x", 1],
      ],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "a",
          changes: [{ type: "put", path: "f", content: "YQ==" }],
        },
        {
          author: "b@x",
          revision: 1,
          base: [],
          message: "b",
          changes: [{ type: "delete", path: "f" }],
        },
      ],
    },
    "delete of absent path: f",
  );
});

void test("tree paths conflict within one authored result", () => {
  expectInvalid(
    {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "prefix",
          changes: [
            { type: "put", path: "a", content: "YQ==" },
            { type: "put", path: "a/b", content: "Yg==" },
          ],
        },
      ],
    },
    "tree paths conflict",
  );
});

void test("valid multi-patch repository validates and round-trips", () => {
  const repoValue = {
    format: 1,
    frontier: [
      ["a@x", 1],
      ["b@x", 1],
    ],
    patches: [
      {
        author: "a@x",
        revision: 1,
        base: [],
        message: "a",
        changes: [{ type: "put", path: "a", content: "YQ==" }],
      },
      {
        author: "b@x",
        revision: 1,
        base: [["a@x", 1]],
        message: "b",
        changes: [{ type: "put", path: "b", content: "Yg==" }],
      },
    ],
  };
  const value = unwrap(validateRepositoryJson(repoValue));
  assert.equal(value.frontier.length, 2);
  const text = serializeRepository(value);
  assert.ok(text.endsWith("\n"));
  unwrap(validateRepositoryJson(JSON.parse(text)));
});

void test("serializeRepository emits fixed key order, two-space indent, trailing LF", () => {
  const repo: Repository = {
    format: 1,
    frontier: [["alice@example.com", 1]],
    patches: [
      {
        author: "alice@example.com",
        revision: 1,
        base: [],
        message: "add greeting",
        changes: [{ type: "text", path: "hello.txt", edit: [{ insert: ["hello\n"] }] }],
      },
    ],
  };
  const text = serializeRepository(repo);
  const expected = [
    "{",
    '  "format": 1,',
    '  "frontier": [',
    "    [",
    '      "alice@example.com",',
    "      1",
    "    ]",
    "  ],",
    '  "patches": [',
    "    {",
    '      "author": "alice@example.com",',
    '      "revision": 1,',
    '      "base": [],',
    '      "message": "add greeting",',
    '      "changes": [',
    "        {",
    '          "type": "text",',
    '          "path": "hello.txt",',
    '          "edit": [',
    "            {",
    '              "insert": [',
    '                "hello\\n"',
    "              ]",
    "            }",
    "          ]",
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
    "",
  ].join("\n");
  assert.equal(text, expected);
});

void test("loadRepository and saveRepository round-trip through a temp file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "snap-repo-test-"));
  try {
    const repo: Repository = {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "m",
          changes: [{ type: "put", path: "f", content: "YQ==" }],
        },
      ],
    };
    await Effect.runPromise(saveRepository(dir, repo));
    const loaded = await Effect.runPromise(Effect.either(readRepositoryJson(dir)));
    if (loaded._tag === "Left") {
      assert.fail("expected repository load to succeed");
    }
    assert.equal(loaded.right?.frontier[0]?.[0], "a@x");
    const raw = await readFile(path.join(dir, ".snap", "repository.json"), "utf8");
    assert.equal(raw, serializeRepository(repo));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("readRepositoryJson surfaces parse errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "snap-repo-parse-"));
  try {
    await mkdir(path.join(dir, ".snap"));
    await writeFile(
      path.join(dir, ".snap", "repository.json"),
      '{"format":1,"format":1,"frontier":[],"patches":[]}',
    );
    const result = await Effect.runPromise(Effect.either(readRepositoryJson(dir)));
    if (result._tag === "Left") {
      assert.ok(result.left.detail.includes("duplicate JSON key"));
    } else {
      assert.fail("expected a parse error");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
