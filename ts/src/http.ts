import * as http from "node:http";
import * as https from "node:https";
import { Effect } from "effect";

import { SnapError, internalError, userError } from "./errors.js";
import { parseJson } from "./json.js";
import { validateRepositoryJson } from "./repository.js";
import type { Repository } from "./types.js";

/**
 * A bound snapshot server: the resolved `url`/`baseUrl` plus an idempotent
 * `close` that stops accepting and drops existing connections.
 */
export type SnapshotServer = {
  readonly url: string;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
};

const REPOSITORY_PATH = "/repository.json";

const describeError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  return "unknown error";
};

/**
 * The only resource is `GET`/`HEAD /repository.json` (§9): exact target, other
 * methods get `405 Allow: GET, HEAD`, other paths get `404`.
 */
const handleRequest = (
  repoText: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  const method = req.method ?? "";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (req.url !== REPOSITORY_PATH) {
    res.writeHead(404);
    res.end();
    return;
  }
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(repoText, "utf8")),
  };
  res.writeHead(200, headers);
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(repoText);
};

const bindServer = (
  repoText: string,
  port: number,
): Promise<{ server: http.Server; actualPort: number }> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(repoText, req, res);
    });
    let settled = false;
    const onError = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    server.on("error", onError);
    server.listen(port, "127.0.0.1", () => {
      settled = true;
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server is not listening on a TCP port"));
        return;
      }
      resolve({ server, actualPort: address.port });
    });
  });

const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });

/**
 * Binds a snapshot server to `127.0.0.1:port` (port `0` selects an OS port)
 * and returns its URL without printing anything. Intended for callers that want
 * the handle directly; `serve` adds the stdout URL line and signal handling.
 */
export const startSnapshotServer = (
  repoText: string,
  port: number,
): Effect.Effect<SnapshotServer, SnapError> =>
  Effect.tryPromise({
    try: async () => {
      const { server, actualPort } = await bindServer(repoText, port);
      const baseUrl = `http://127.0.0.1:${String(actualPort)}`;
      return {
        baseUrl,
        url: `${baseUrl}${REPOSITORY_PATH}`,
        close: () => closeServer(server),
      };
    },
    catch: (err) =>
      internalError(`cannot listen on 127.0.0.1:${String(port)}: ${describeError(err)}`),
  });

const writeStdoutFlushed = (text: string): Effect.Effect<void, SnapError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(text, (err) => {
          if (err === undefined || err === null) {
            resolve();
          } else {
            reject(err);
          }
        });
      }),
    catch: (err) => internalError(`cannot write to stdout: ${describeError(err)}`),
  });

/** Waits for SIGINT/SIGTERM, closes the server, then completes successfully. */
const waitForInterruptAndClose = (handle: SnapshotServer): Effect.Effect<void, SnapError> =>
  Effect.async((resume: (effect: Effect.Effect<void, SnapError>) => void) => {
    const removeListeners = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    const onSignal = (): void => {
      removeListeners();
      void handle.close().then(
        () => {
          resume(Effect.void);
        },
        (err: unknown) => {
          resume(Effect.fail(internalError(`cannot close HTTP server: ${describeError(err)}`)));
        },
      );
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    return Effect.sync(() => {
      removeListeners();
      void handle.close();
    });
  });

/**
 * `snap --serve [port]` (§7.9): prints the flushed plain URL, serves the frozen
 * startup snapshot, and exits 0 on SIGINT/SIGTERM.
 */
export const serve = (repoText: string, port: number): Effect.Effect<void, SnapError> =>
  Effect.gen(function* () {
    const handle = yield* startSnapshotServer(repoText, port);
    yield* writeStdoutFlushed(`${handle.url}\n`);
    yield* waitForInterruptAndClose(handle);
  });

type FetchOutcome =
  | { readonly _tag: "body"; readonly body: string }
  | { readonly _tag: "status"; readonly status: number }
  | { readonly _tag: "transport"; readonly detail: string };

const openRequest = (
  url: URL,
  onResponse: (res: http.IncomingMessage) => void,
): http.ClientRequest => {
  if (url.protocol === "https:") {
    return https.request(url, { method: "GET" }, onResponse);
  }
  return http.request(url, { method: "GET" }, onResponse);
};

/** One plain GET: transport errors and non-200 statuses resolve as outcomes. */
const performGet = (url: URL): Promise<FetchOutcome> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: FetchOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    const transport = (err: Error): void => {
      finish({ _tag: "transport", detail: describeError(err) });
    };
    const onResponse = (res: http.IncomingMessage): void => {
      const status = res.statusCode;
      if (status === undefined || status !== 200) {
        res.resume();
        finish({ _tag: "status", status: status ?? 0 });
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("aborted", () => {
        finish({ _tag: "transport", detail: "connection aborted" });
      });
      res.on("error", transport);
      res.on("end", () => {
        finish({ _tag: "body", body: Buffer.concat(chunks).toString("utf8") });
      });
    };
    const request = openRequest(url, onResponse);
    request.on("error", transport);
    request.end();
  });

const requestRepository = (url: URL): Effect.Effect<FetchOutcome, SnapError> =>
  Effect.tryPromise({
    try: () => performGet(url),
    catch: (err) => internalError(`cannot fetch ${url.toString()}: ${describeError(err)}`),
  });

const parseHttpUrl = (urlText: string): Effect.Effect<URL, SnapError> => {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return Effect.fail(userError(`invalid repository URL: ${urlText}`));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Effect.fail(userError("repository URL must use http or https"));
  }
  return Effect.succeed(url);
};

const outcomeError = (urlText: string, outcome: FetchOutcome): SnapError => {
  if (outcome._tag === "status") {
    return userError(`server returned HTTP ${String(outcome.status)}`);
  }
  if (outcome._tag === "transport") {
    return internalError(`cannot fetch ${urlText}: ${outcome.detail}`);
  }
  return internalError(`cannot fetch ${urlText}: empty response body`);
};

const parseAndValidateBody = (body: string): Effect.Effect<Repository, SnapError> => {
  const parsed = parseJson(body);
  if (parsed._tag === "err") {
    return Effect.fail(userError(parsed.detail));
  }
  const validated = validateRepositoryJson(parsed.value);
  if (validated._tag === "err") {
    return Effect.fail(userError(validated.detail));
  }
  return Effect.succeed(validated.value);
};

/**
 * One exact GET of the URL (§9): requires status 200, never follows redirects,
 * then parses and validates the body as a repository.
 */
export const fetchRepository = (urlText: string): Effect.Effect<Repository, SnapError> =>
  Effect.gen(function* () {
    const url = yield* parseHttpUrl(urlText);
    const outcome = yield* requestRepository(url);
    if (outcome._tag !== "body") {
      return yield* Effect.fail(outcomeError(urlText, outcome));
    }
    return yield* parseAndValidateBody(outcome.body);
  });
