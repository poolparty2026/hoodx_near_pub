import { describe, expect, it } from "vitest";
import { canonicalize, strictParse } from "../src/json.ts";
import { RulesError } from "../src/errors.ts";

const code = (f: () => unknown): string => {
  try { f(); } catch (e) { return (e as RulesError).code; }
  return "NO_ERROR";
};

describe("strictParse and canonicalize (EC-R01)", () => {
  it("sorts keys by UTF-16 code units and drops whitespace", () => {
    expect(canonicalize(strictParse(' { "b" : 1 , "a" : [ true , null , "x" ] } '))).toBe('{"a":[true,null,"x"],"b":1}');
    // "é" (é) sorts after "z"; "A" before "a"; an astral char (surrogates 0xD83D) after both.
    expect(canonicalize(strictParse('{"z":1,"\\u00e9":2,"a":3,"A":4,"😀":5}'))).toBe('{"A":4,"a":3,"z":1,"é":2,"😀":5}');
  });
  it("serialises strings as ECMAScript JSON.stringify does", () => {
    expect(canonicalize(strictParse('"\\u0000\\u001f\\"\\\\\\/\\u2028é"'))).toBe('"\\u0000\\u001f\\"\\\\/ é"');
  });
  it("gives identical bytes for differently formatted equal inputs", () => {
    const a = canonicalize(strictParse('{"x":{"q":2,"p":1},"y":[1,2]}'));
    const b = canonicalize(strictParse('{\n  "y": [1, 2],\n  "x": { "p": 1, "q": 2 }\n}'));
    expect(a).toBe(b);
  });
  it("refuses duplicate keys", () => {
    expect(code(() => strictParse('{"a":1,"a":2}'))).toBe("JSON_DUPLICATE_KEY");
    expect(code(() => strictParse('{"o":{"k":1,"k":1}}'))).toBe("JSON_DUPLICATE_KEY");
  });
  it.each(["1.0", "1e2", "1E2", "1.5", "-0", "9007199254740993", "-9007199254740993", "01", "+1"])(
    "refuses the number %s (EC-R09)", (n) => {
      expect(["JSON_NUMBER", "JSON_SYNTAX"]).toContain(code(() => strictParse(`{"n":${n}}`)));
    });
  it("accepts safe integers at the bounds", () => {
    expect(strictParse("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(strictParse("-9007199254740991")).toBe(-Number.MAX_SAFE_INTEGER);
  });
  it.each(['{"a":1', '{"a" 1}', '[1,]', '"unterminated', '{"a":1} x', "tru", '"\u0001"', '{1:2}', '"\\x"', "[1 2]", "{\"a\":1 \"b\":2}"])(
    "refuses malformed JSON %s", (t) => {
      expect(code(() => strictParse(t))).toBe("JSON_SYNTAX");
    });
  it("refuses nesting deeper than 32", () => {
    expect(code(() => strictParse("[".repeat(40) + "]".repeat(40)))).toBe("JSON_SYNTAX");
  });
  it("refuses non-integers and unsupported values in canonicalize", () => {
    expect(code(() => canonicalize(1.5))).toBe("CANON_VALUE");
    expect(code(() => canonicalize(-0))).toBe("CANON_VALUE");
    expect(code(() => canonicalize(undefined as never))).toBe("CANON_VALUE");
  });
  it("doesn't let __proto__ keys pollute prototypes", () => {
    const v = strictParse('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(canonicalize(v as never)).toBe('{"__proto__":{"polluted":1}}');
  });
});

describe("strictParse limits and exact codes (EC-R01, EC-R09)", () => {
  it("refuses a duplicate key written with an escape", () => {
    expect(code(() => strictParse('{"a":1,"\\u0061":2}'))).toBe("JSON_DUPLICATE_KEY");
  });
  it.each([["-0", "JSON_NUMBER"], ["1.0", "JSON_NUMBER"], ["1e2", "JSON_NUMBER"], ["9007199254740993", "JSON_NUMBER"], ["01", "JSON_SYNTAX"], ["+1", "JSON_SYNTAX"], ["-", "JSON_SYNTAX"]])(
    "refuses %s with %s", (n, c) => {
      expect(code(() => strictParse(`{"n":${n}}`))).toBe(c);
    });
  it("accepts nesting at depth 32 and refuses 33", () => {
    expect(() => strictParse("[".repeat(33) + "]".repeat(33))).not.toThrow();
    expect(code(() => strictParse("[".repeat(34) + "]".repeat(34)))).toBe("JSON_SYNTAX");
  });
  it("refuses input over 4096 characters, and non-strings", () => {
    expect(() => strictParse(" ".repeat(4096) + "1")).toThrow("JSON_SYNTAX: input longer than 4096 characters");
    expect(() => strictParse(`"${"a".repeat(4094)}"`)).not.toThrow();
    expect(() => strictParse(5 as never)).toThrow("JSON_SYNTAX: input must be a string");
  });
  it("truncates attacker keys in error messages", () => {
    expect.assertions(2);
    const key = "<img onerror=x>".repeat(10);
    try { strictParse(`{"${key}":1,"${key}":2}`); } catch (e) {
      expect((e as Error).message).not.toContain(key);
      expect((e as Error).message.length).toBeLessThan(120);
    }
  });
  it("canonicalises false, empty objects and empty arrays", () => {
    expect(canonicalize(strictParse('{"f":false,"o":{},"a":[]}'))).toBe('{"a":[],"f":false,"o":{}}');
  });
});
