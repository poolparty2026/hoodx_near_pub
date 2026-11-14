import { RulesError } from "./errors.ts";

/**
 * JSON values allowed in Poolside rules: objects, arrays, strings, booleans,
 * null and safe integers. Fractions, exponents, -0 and integers outside
 * Number.MAX_SAFE_INTEGER are refused (EC-R01, EC-R09).
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Strict JSON parser. Unlike JSON.parse it refuses duplicate object keys
 * (EC-R01) and any number that isn't a plain safe integer. This is a
 * deliberately stricter value domain than RFC 8785, which would accept and
 * re-serialise 1.0 or 1e2; Poolside refuses them (EC-R09).
 *
 * Exact grammar and error order, for any port (EC-R25). The reported error is the
 * first one met in a single left-to-right read, after one whole-input pre-check for
 * lone surrogates; only the error code is normative (reasons and offsets, which count
 * UTF-16 code units, are informative):
 *   - input longer than MAX_JSON_LENGTH UTF-16 code units: JSON_SYNTAX;
 *   - input or a decoded string that isn't well-formed UTF-16 (a lone surrogate,
 *     escaped or not): JSON_SYNTAX;
 *   - a number is read as the longest prefix matching -?(0|[1-9][0-9]*); if a ".",
 *     "e" or "E" follows, JSON_NUMBER; else if the prefix is "-0", JSON_NUMBER;
 *     else if it is outside +-(2^53 - 1), JSON_NUMBER. Anything left over (such as
 *     the "100" of "0100") then fails where the parser expects "," or "}"
 *     (JSON_SYNTAX). Error offsets point at the start of the number;
 *   - a repeated object key, compared after unescaping, is reported when the key is
 *     read, before its value: JSON_DUPLICATE_KEY;
 *   - nesting: the top-level value is at depth 0 and each value inside an object or
 *     array is one deeper; any value (scalars included) at depth more than 32 is
 *     JSON_SYNTAX. So 33 nested empty arrays pass, but 33 nested arrays with a
 *     scalar inside fail, since the scalar sits at depth 33.
 */
export const MAX_JSON_LENGTH = 4096;

/** Whether `s` holds a high surrogate without a following low one, or a low one without a preceding high one. */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

export function strictParse(text: string): JsonValue {
  if (typeof text !== "string") throw new RulesError("JSON_SYNTAX", "input must be a string");
  if (text.length > MAX_JSON_LENGTH) throw new RulesError("JSON_SYNTAX", `input longer than ${MAX_JSON_LENGTH} characters`);
  if (hasLoneSurrogate(text)) throw new RulesError("JSON_SYNTAX", "input is not well-formed UTF-16 (lone surrogate)");
  let i = 0;
  const fail = (code: "JSON_SYNTAX" | "JSON_DUPLICATE_KEY" | "JSON_NUMBER", msg: string): never => {
    throw new RulesError(code, `${msg} at offset ${i}`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i++;
  };
  const value = (depth: number): JsonValue => {
    if (depth > 32) fail("JSON_SYNTAX", "nesting too deep");
    ws();
    const c = text[i];
    if (c === "{") return object(depth);
    if (c === "[") return array(depth);
    if (c === '"') return string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return number();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    return fail("JSON_SYNTAX", "unexpected character");
  };
  const object = (depth: number): JsonValue => {
    i++;
    const out: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    const seen = new Set<string>();
    ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail("JSON_SYNTAX", "expected key");
      const key = string();
      if (seen.has(key)) fail("JSON_DUPLICATE_KEY", `duplicate key ${JSON.stringify(key.slice(0, 32))}`);
      seen.add(key);
      ws();
      if (text[i] !== ":") fail("JSON_SYNTAX", "expected ':'");
      i++;
      out[key] = value(depth + 1);
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      fail("JSON_SYNTAX", "expected ',' or '}'");
    }
  };
  const array = (depth: number): JsonValue => {
    i++;
    const out: JsonValue[] = [];
    ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value(depth + 1));
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      fail("JSON_SYNTAX", "expected ',' or ']'");
    }
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      const ch = text.charCodeAt(i);
      if (ch < 0x20) fail("JSON_SYNTAX", "control character in string");
      i += text[i] === "\\" ? 2 : 1;
    }
    if (i >= text.length) fail("JSON_SYNTAX", "unterminated string");
    i++;
    let s: string;
    try {
      s = JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail("JSON_SYNTAX", "invalid string escape");
    }
    // An escaped lone surrogate (\ud800) decodes to a string no Rust String can hold.
    if (hasLoneSurrogate(s)) return fail("JSON_SYNTAX", "lone surrogate escape in string");
    return s;
  };
  const number = (): number => {
    const m = /^-?(0|[1-9][0-9]*)([.eE][-+0-9.eE]*)?/.exec(text.slice(i));
    if (!m) return fail("JSON_SYNTAX", "invalid number");
    if (m[2] !== undefined) return fail("JSON_NUMBER", "only integers are allowed");
    const literal = m[0];
    if (literal === "-0") return fail("JSON_NUMBER", "-0 is not allowed");
    const n = Number(literal);
    if (!Number.isSafeInteger(n)) return fail("JSON_NUMBER", "integer outside the safe range");
    i += literal.length;
    return n;
  };
  const result = value(0);
  ws();
  if (i !== text.length) fail("JSON_SYNTAX", "trailing characters");
  return result;
}

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the value domain above.
 * Keys are sorted by UTF-16 code units, strings are serialised as
 * ECMAScript JSON.stringify does, and integers in their shortest form.
 */
export function canonicalize(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new RulesError("CANON_VALUE", "only safe integers can be canonicalised");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((v as { [key: string]: JsonValue })[k] as JsonValue)}`).join(",")}}`;
  }
  throw new RulesError("CANON_VALUE", `unsupported value of type ${typeof v}`);
}
