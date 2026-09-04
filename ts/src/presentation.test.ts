import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Result } from "./types.js";
import type { Presentation } from "./presentation.js";
import {
  escapeLogMessage,
  renderLogEntry,
  renderStatusClean,
  renderStatusHeader,
  renderStatusRow,
  renderSuccess,
  renderVersionOutput,
  resolvePresentation,
  sgr,
  versionLine,
} from "./presentation.js";

const expectOk = (result: Result<Presentation>): Presentation => {
  if (result._tag !== "ok") {
    assert.fail(`expected ok, got err: ${result.detail}`);
  }
  return result.value;
};

const expectErr = (result: Result<Presentation>): string => {
  if (result._tag !== "err") {
    assert.fail(`expected err, got ok: ${JSON.stringify(result.value)}`);
  }
  return result.detail;
};

const terminal: Presentation = { stdout: "terminal", stderr: "terminal" };
const plain: Presentation = { stdout: "plain", stderr: "plain" };
const ttyCombos: readonly boolean[] = [true, false];

void test("auto and unset SNAP_COLOR select each stream independently on tty", () => {
  for (const snapColor of ["auto", undefined] as const) {
    for (const stdoutIsTty of ttyCombos) {
      for (const stderrIsTty of ttyCombos) {
        const expected: Presentation = {
          stdout: stdoutIsTty ? "terminal" : "plain",
          stderr: stderrIsTty ? "terminal" : "plain",
        };
        assert.deepEqual(
          expectOk(resolvePresentation(snapColor, undefined, stdoutIsTty, stderrIsTty)),
          expected,
        );
      }
    }
  }
});

void test("always forces terminal on both streams and overrides NO_COLOR", () => {
  for (const noColor of [undefined, "", "1"]) {
    for (const stdoutIsTty of ttyCombos) {
      for (const stderrIsTty of ttyCombos) {
        assert.deepEqual(
          expectOk(resolvePresentation("always", noColor, stdoutIsTty, stderrIsTty)),
          terminal,
        );
      }
    }
  }
});

void test("NO_COLOR present including empty forces plain in auto and unset", () => {
  for (const snapColor of ["auto", undefined] as const) {
    for (const noColor of ["", "1"]) {
      for (const stdoutIsTty of ttyCombos) {
        for (const stderrIsTty of ttyCombos) {
          assert.deepEqual(
            expectOk(resolvePresentation(snapColor, noColor, stdoutIsTty, stderrIsTty)),
            plain,
          );
        }
      }
    }
  }
});

void test("never forces plain on both streams even for a tty", () => {
  for (const noColor of [undefined, ""]) {
    for (const stdoutIsTty of ttyCombos) {
      for (const stderrIsTty of ttyCombos) {
        assert.deepEqual(
          expectOk(resolvePresentation("never", noColor, stdoutIsTty, stderrIsTty)),
          plain,
        );
      }
    }
  }
});

void test("invalid SNAP_COLOR errors with the exact detail", () => {
  for (const snapColor of ["sometimes", "ALWAYS", "AUTO", ""]) {
    assert.equal(
      expectErr(resolvePresentation(snapColor, undefined, true, true)),
      "SNAP_COLOR must be auto, always, or never",
    );
  }
});

void test("sgr emits the documented SGR wrapping", () => {
  assert.equal(sgr(1, "snap 1.0.0"), "\u001b[1msnap 1.0.0\u001b[0m");
  assert.equal(sgr(2, "(added)"), "\u001b[2m(added)\u001b[0m");
  assert.equal(sgr(32, "✓"), "\u001b[32m✓\u001b[0m");
  assert.equal(sgr(33, "~"), "\u001b[33m~\u001b[0m");
  assert.equal(sgr(35, "alice@x"), "\u001b[35malice@x\u001b[0m");
  assert.equal(sgr(36, "()"), "\u001b[36m()\u001b[0m");
  assert.equal(sgr(31, "✗ snap: bad"), "\u001b[31m✗ snap: bad\u001b[0m");
});

void test("escapeLogMessage escapes backslash tab and LF in that order", () => {
  assert.equal(escapeLogMessage("a\\b"), "a\\\\b");
  assert.equal(escapeLogMessage("a\tb"), "a\\tb");
  assert.equal(escapeLogMessage("a\nb"), "a\\nb");
  assert.equal(escapeLogMessage("first\tline\nsecond\\tail"), "first\\tline\\nsecond\\\\tail");
  assert.equal(escapeLogMessage(""), "");
  assert.equal(escapeLogMessage("plain"), "plain");
});

void test("terminal builders render the exact test 28 layout families", () => {
  assert.equal(
    renderSuccess("Committed", "(alice@x->1)"),
    "\u001b[32m✓\u001b[0m \u001b[1mCommitted\u001b[0m \u001b[36m(alice@x->1)\u001b[0m\n",
  );
  assert.equal(
    renderStatusHeader("()"),
    "\u001b[1mSnap status\u001b[0m  \u001b[36m()\u001b[0m\n\n",
  );
  assert.equal(renderStatusClean(), "  \u001b[32m✓\u001b[0m Working tree clean\n");
  assert.equal(
    renderStatusRow("A", "added.txt"),
    "  \u001b[32m+\u001b[0m added.txt \u001b[2m(added)\u001b[0m\n",
  );
  assert.equal(
    renderStatusRow("M", "src/main.ts"),
    "  \u001b[33m~\u001b[0m src/main.ts \u001b[2m(modified)\u001b[0m\n",
  );
  assert.equal(
    renderStatusRow("D", "old.txt"),
    "  \u001b[31m−\u001b[0m old.txt \u001b[2m(deleted)\u001b[0m\n",
  );
  assert.equal(
    renderLogEntry("first", "(alice@x->1)", "alice@x"),
    "\u001b[36m●\u001b[0m \u001b[1mfirst\u001b[0m\n  \u001b[36m(alice@x->1)\u001b[0m \u001b[2mby\u001b[0m \u001b[35malice@x\u001b[0m\n",
  );
  assert.equal(versionLine(), "snap 1.0.0");
  assert.equal(renderVersionOutput(), "\u001b[1msnap 1.0.0\u001b[0m\n");
});
