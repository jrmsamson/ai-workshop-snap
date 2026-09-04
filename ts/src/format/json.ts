import { err, ok } from "../core/types.js";
import type { Result } from "../core/types.js";

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

const MAX_DEPTH = 512;

const isDigit = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
};

/**
 * A total, recursive-descent RFC 8259 JSON parser. It rejects malformed input
 * and duplicate object keys but leaves number semantics (non-integers,
 * overflow, lossy doubles) untouched for downstream validation.
 */
class JsonParser {
  private readonly input: string;
  private pos = 0;
  private depth = 0;

  constructor(input: string) {
    this.input = input;
  }

  parse(): Result<unknown> {
    this.skipWhitespace();
    const valueResult = this.parseValue("");
    if (valueResult._tag === "err") {
      return valueResult;
    }
    this.skipWhitespace();
    if (!this.atEnd()) {
      return err(
        `invalid JSON: trailing characters after top-level value at index ${String(this.pos)}`,
      );
    }
    return ok(valueResult.value);
  }

  private atEnd(): boolean {
    return this.pos >= this.input.length;
  }

  private peek(): string {
    return this.input.charAt(this.pos);
  }

  private advance(): void {
    this.pos += 1;
  }

  private skipWhitespace(): void {
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.advance();
      } else {
        return;
      }
    }
  }

  private parseValue(path: string): Result<unknown> {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === "{") {
      if (this.depth >= MAX_DEPTH) {
        return err("invalid JSON: maximum nesting depth exceeded");
      }
      this.depth += 1;
      const result = this.parseObject(path);
      this.depth -= 1;
      return result;
    }
    if (ch === "[") {
      if (this.depth >= MAX_DEPTH) {
        return err("invalid JSON: maximum nesting depth exceeded");
      }
      this.depth += 1;
      const result = this.parseArray(path);
      this.depth -= 1;
      return result;
    }
    if (ch === '"') {
      return this.parseString();
    }
    if (ch === "-" || isDigit(ch)) {
      return this.parseNumber();
    }
    if (ch === "t") {
      return this.parseKeyword("true", true);
    }
    if (ch === "f") {
      return this.parseKeyword("false", false);
    }
    if (ch === "n") {
      return this.parseKeyword("null", null);
    }
    return err(`invalid JSON: expected a value at index ${String(this.pos)}`);
  }

  private parseObject(path: string): Result<Record<string, unknown>> {
    this.advance();
    const object: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.advance();
      return ok(object);
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        return err(`invalid JSON: expected an object key at index ${String(this.pos)}`);
      }
      const keyResult = this.parseString();
      if (keyResult._tag === "err") {
        return keyResult;
      }
      const key = keyResult.value;
      this.skipWhitespace();
      if (this.peek() !== ":") {
        return err(`invalid JSON: expected ':' after object key at index ${String(this.pos)}`);
      }
      this.advance();
      const keyPath = path === "" ? key : `${path}.${key}`;
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        return err(`duplicate JSON key ${keyPath}`);
      }
      const valueResult = this.parseValue(keyPath);
      if (valueResult._tag === "err") {
        return valueResult;
      }
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        value: valueResult.value,
        writable: true,
      });
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === ",") {
        this.advance();
        continue;
      }
      if (ch === "}") {
        this.advance();
        return ok(object);
      }
      return err(`invalid JSON: expected ',' or '}' in object at index ${String(this.pos)}`);
    }
  }

  private parseArray(path: string): Result<unknown[]> {
    this.advance();
    const array: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.advance();
      return ok(array);
    }
    for (;;) {
      const valueResult = this.parseValue(path);
      if (valueResult._tag === "err") {
        return valueResult;
      }
      array.push(valueResult.value);
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === ",") {
        this.advance();
        continue;
      }
      if (ch === "]") {
        this.advance();
        return ok(array);
      }
      return err(`invalid JSON: expected ',' or ']' in array at index ${String(this.pos)}`);
    }
  }

  private parseString(): Result<string> {
    this.advance();
    const parts: string[] = [];
    let runStart = this.pos;
    for (;;) {
      if (this.atEnd()) {
        return err("invalid JSON: unterminated string");
      }
      const ch = this.peek();
      if (ch === '"') {
        if (this.pos > runStart) {
          parts.push(this.input.slice(runStart, this.pos));
        }
        this.advance();
        return ok(parts.join(""));
      }
      if (ch === "\\") {
        if (this.pos > runStart) {
          parts.push(this.input.slice(runStart, this.pos));
        }
        this.advance();
        const escapeResult = this.parseEscape();
        if (escapeResult._tag === "err") {
          return escapeResult;
        }
        parts.push(escapeResult.value);
        runStart = this.pos;
        continue;
      }
      if (ch.charCodeAt(0) < 32) {
        return err(
          `invalid JSON: unescaped control character in string at index ${String(this.pos)}`,
        );
      }
      this.advance();
    }
  }

  private parseEscape(): Result<string> {
    const ch = this.peek();
    this.advance();
    switch (ch) {
      case '"':
        return ok('"');
      case "\\":
        return ok("\\");
      case "/":
        return ok("/");
      case "b":
        return ok("\b");
      case "f":
        return ok("\f");
      case "n":
        return ok("\n");
      case "r":
        return ok("\r");
      case "t":
        return ok("\t");
      case "u": {
        if (this.pos + 4 > this.input.length) {
          return err(`invalid JSON: truncated \\u escape at index ${String(this.pos)}`);
        }
        const hex = this.input.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return err(`invalid JSON: invalid \\u escape at index ${String(this.pos)}`);
        }
        this.advance();
        this.advance();
        this.advance();
        this.advance();
        return ok(String.fromCharCode(Number.parseInt(hex, 16)));
      }
      default:
        return err(`invalid JSON: invalid escape at index ${String(this.pos - 1)}`);
    }
  }

  private parseNumber(): Result<number> {
    const start = this.pos;
    while (!this.atEnd()) {
      const ch = this.peek();
      const code = ch.charCodeAt(0);
      const digit = code >= 48 && code <= 57;
      if (!digit && ch !== "-" && ch !== "+" && ch !== "." && ch !== "e" && ch !== "E") {
        break;
      }
      this.advance();
    }
    const token = this.input.slice(start, this.pos);
    if (!JSON_NUMBER.test(token)) {
      return err(`invalid JSON: invalid number at index ${String(start)}`);
    }
    return ok(Number(token));
  }

  private parseKeyword(word: string, value: unknown): Result<unknown> {
    if (this.input.startsWith(word, this.pos)) {
      this.pos += word.length;
      return ok(value);
    }
    return err(`invalid JSON: invalid literal at index ${String(this.pos)}`);
  }
}

/** Parse a UTF-8 JSON document into an `unknown` value, or describe the failure. */
export const parseJson = (input: string): Result<unknown> => new JsonParser(input).parse();
