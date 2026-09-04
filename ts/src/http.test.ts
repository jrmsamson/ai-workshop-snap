import assert from "node:assert/strict";
import * as http from "node:http";
import { test, type TestContext } from "node:test";
import { Effect, Either } from "effect";

import { fetchRepository, startSnapshotServer } from "./http.js";
import type { SnapshotServer } from "./http.js";
import { parseJson } from "./json.js";
import { serializeRepository, validateRepositoryJson } from "./repository.js";
import type { Repository } from "./types.js";
import { type SnapError } from "./errors.js";

const run = <A>(effect: Effect.Effect<A, SnapError>): Promise<A> => Effect.runPromise(effect);

const leftError = async (effect: Effect.Effect<unknown, SnapError>): Promise<SnapError> => {
  const either = await Effect.runPromise(Effect.either(effect));
  assert.ok(Either.isLeft(either), "expected the effect to fail");
  return either.left;
};

const unwrap = <A>(result: { _tag: "ok"; value: A } | { _tag: "err"; detail: string }): A => {
  if (result._tag === "err") {
    assert.fail(`unexpected error: ${result.detail}`);
  }
  return result.value;
};

const sampleText = (): string => {
  const repo: Repository = {
    format: 1,
    frontier: [["a@x", 1]],
    patches: [
      {
        author: "a@x",
        revision: 1,
        base: [],
        message: "one",
        changes: [{ type: "put", path: "file.txt", content: "b25l" }],
      },
    ],
  };
  return serializeRepository(repo);
};

const expectedRepository = (text: string): Repository =>
  unwrap(validateRepositoryJson(unwrap(parseJson(text))));

const startServer = async (t: TestContext, text: string): Promise<SnapshotServer> => {
  const handle = await run(startSnapshotServer(text, 0));
  t.after(async () => {
    await handle.close();
  });
  return handle;
};

type RawResponse = {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
};

const rawRequest = (target: string, method = "GET"): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const request = http.request(target, { method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });

void test("server round-trips the startup snapshot over one GET", async (t) => {
  const text = sampleText();
  const handle = await startServer(t, text);
  const fetched = await run(fetchRepository(handle.url));
  assert.deepEqual(fetched, expectedRepository(text));
});

void test("GET returns the exact startup bytes", async (t) => {
  const text = sampleText();
  const handle = await startServer(t, text);
  const response = await rawRequest(handle.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["content-length"], String(Buffer.byteLength(text, "utf8")));
  assert.equal(response.body, text);
});

void test("HEAD returns 200 with the same headers and no body", async (t) => {
  const text = sampleText();
  const handle = await startServer(t, text);
  const response = await rawRequest(handle.url, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["content-length"], String(Buffer.byteLength(text, "utf8")));
  assert.equal(response.body, "");
});

void test("server rejects non-exact targets and methods", async (t) => {
  const handle = await startServer(t, sampleText());
  const queried = await rawRequest(`${handle.url}?query=not-exact`);
  assert.equal(queried.status, 404);
  const wrongPath = await rawRequest(`${handle.baseUrl}/other.json`);
  assert.equal(wrongPath.status, 404);
  const posted = await rawRequest(handle.url, "POST");
  assert.equal(posted.status, 405);
  assert.equal(posted.headers["allow"], "GET, HEAD");
});

void test("every fresh connection serves the same frozen startup bytes", async (t) => {
  const text = sampleText();
  const handle = await startServer(t, text);
  const first = await rawRequest(handle.url);
  const second = await rawRequest(handle.url);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body, text);
  assert.equal(second.body, text);
});

type InlineServer = {
  readonly baseUrl: string;
  readonly hits: string[];
  readonly close: () => Promise<void>;
};

const closeHttpServer = (server: http.Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });

const startInlineServer = (
  t: TestContext,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<InlineServer> =>
  new Promise((resolve) => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const inline: InlineServer = {
        baseUrl: `http://127.0.0.1:${String(port)}`,
        hits,
        close: () => closeHttpServer(server),
      };
      t.after(async () => {
        await inline.close();
      });
      resolve(inline);
    });
  });

void test("fetchRepository does one exact GET and never follows redirects", async (t) => {
  const { baseUrl, hits } = await startInlineServer(t, (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/bad" });
      res.end();
      return;
    }
    if (req.url === "/bad") {
      res.writeHead(200);
      res.end("not-json");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const redirected = await leftError(fetchRepository(`${baseUrl}/redirect`));
  assert.equal(redirected.code, 1);
  assert.ok(redirected.detail.includes("HTTP 302"), redirected.detail);
  const notJson = await leftError(fetchRepository(`${baseUrl}/bad`));
  assert.equal(notJson.code, 1);
  assert.ok(notJson.detail.includes("invalid JSON"), notJson.detail);
  assert.deepEqual(hits, ["/redirect", "/bad"]);
});

void test("fetchRepository maps transport failures to internal errors", async (t) => {
  const inline = await startInlineServer(t, (_req, res) => {
    res.writeHead(200);
    res.end();
  });
  await inline.close();
  const failure = await leftError(fetchRepository(`${inline.baseUrl}/repository.json`));
  assert.equal(failure.code, 2);
});
