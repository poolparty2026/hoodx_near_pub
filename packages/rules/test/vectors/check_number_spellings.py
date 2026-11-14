"""Independent check of test/vectors/number_spellings.json, written from the grammar
documented in src/json.ts (no code shared with packages/rules).

It is a small strict JSON reader of its own that reports the first error met in one
left-to-right read, after a whole-input pre-check for lone surrogates, exactly as the
documented order says. Only the error code is compared (reasons and offsets are
informative). It fails on an empty case list and checks itself on known cases.
Run: python3 -I check_number_spellings.py number_spellings.json"""
import json, re, sys

PREFIX = re.compile(r'-?(0|[1-9][0-9]*)')
LIMIT = 2**53 - 1
MAX_LEN = 4096  # UTF-16 code units


class Err(Exception):
    def __init__(self, code):
        self.code = code


def utf16_len(s):
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def has_lone(s):
    i = 0
    while i < len(s):
        o = ord(s[i])
        if 0xD800 <= o <= 0xDBFF:
            if i + 1 < len(s) and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
                i += 2
                continue
            return True
        if 0xDC00 <= o <= 0xDFFF:
            return True
        i += 1
    return False


def read(text):
    if utf16_len(text) > MAX_LEN or has_lone(text):
        raise Err("JSON_SYNTAX")
    pos = [0]

    def ws():
        while pos[0] < len(text) and text[pos[0]] in " \t\n\r":
            pos[0] += 1

    def string():
        start = pos[0]
        pos[0] += 1
        while pos[0] < len(text) and text[pos[0]] != '"':
            if ord(text[pos[0]]) < 0x20:
                raise Err("JSON_SYNTAX")
            pos[0] += 2 if text[pos[0]] == "\\" else 1
        if pos[0] >= len(text):
            raise Err("JSON_SYNTAX")
        pos[0] += 1
        try:
            s = json.loads(text[start:pos[0]])
        except ValueError:
            raise Err("JSON_SYNTAX")
        # json.loads joins an escaped surrogate pair into one code point; a lone half stays.
        if any(0xD800 <= ord(ch) <= 0xDFFF for ch in s):
            raise Err("JSON_SYNTAX")
        return s

    def number():
        m = PREFIX.match(text, pos[0])
        if not m:
            raise Err("JSON_SYNTAX")
        lit, end = m.group(0), m.end()
        if end < len(text) and text[end] in ".eE":
            raise Err("JSON_NUMBER")
        if lit.startswith("-0"):
            raise Err("JSON_NUMBER")
        if abs(int(lit)) > LIMIT:
            raise Err("JSON_NUMBER")
        pos[0] = end

    def value(depth):
        if depth > 32:
            raise Err("JSON_SYNTAX")
        ws()
        c = text[pos[0]] if pos[0] < len(text) else ""
        if c == "{":
            pos[0] += 1
            seen = set()
            ws()
            if pos[0] < len(text) and text[pos[0]] == "}":
                pos[0] += 1
                return
            while True:
                ws()
                if pos[0] >= len(text) or text[pos[0]] != '"':
                    raise Err("JSON_SYNTAX")
                k = string()
                if k in seen:
                    raise Err("JSON_DUPLICATE_KEY")
                seen.add(k)
                ws()
                if pos[0] >= len(text) or text[pos[0]] != ":":
                    raise Err("JSON_SYNTAX")
                pos[0] += 1
                value(depth + 1)
                ws()
                if pos[0] < len(text) and text[pos[0]] == ",":
                    pos[0] += 1
                    continue
                if pos[0] < len(text) and text[pos[0]] == "}":
                    pos[0] += 1
                    return
                raise Err("JSON_SYNTAX")
        if c == "[":
            pos[0] += 1
            ws()
            if pos[0] < len(text) and text[pos[0]] == "]":
                pos[0] += 1
                return
            while True:
                value(depth + 1)
                ws()
                if pos[0] < len(text) and text[pos[0]] == ",":
                    pos[0] += 1
                    continue
                if pos[0] < len(text) and text[pos[0]] == "]":
                    pos[0] += 1
                    return
                raise Err("JSON_SYNTAX")
        if c == '"':
            string()
            return
        if c == "-" or c.isdigit():
            number()
            return
        for lit in ("true", "false", "null"):
            if text.startswith(lit, pos[0]):
                pos[0] += len(lit)
                return
        raise Err("JSON_SYNTAX")

    value(0)
    ws()
    if pos[0] != len(text):
        raise Err("JSON_SYNTAX")


def expected(raw):
    try:
        read(raw)
    except Err as e:
        return e.code
    return "verdict"


def outcome(case):
    r = case["result"]
    return "verdict" if "verdict" in r else r.get("parseError")


for raw, want in [('{"right":-.5}', "JSON_SYNTAX"), ('{"right":NaN}', "JSON_SYNTAX"), ('{"left":-700 "right":100}', "JSON_SYNTAX"),
                  ('{"right":1,"right":100}', "JSON_DUPLICATE_KEY"), ('{"right":-0}', "JSON_NUMBER"), ('{"right":100}', "verdict"),
                  ('{"left":0100,"right":1e2}', "JSON_SYNTAX"), ('{"a":1,"a":2,"b":1e2}', "JSON_DUPLICATE_KEY"),
                  ("[" * 33 + "]" * 33, "verdict"), ("[" * 34 + "]" * 34, "JSON_SYNTAX"),
                  ("[" * 32 + "1" + "]" * 32, "verdict"), ("[" * 33 + "1" + "]" * 33, "JSON_SYNTAX"),
                  ('{"a":' * 32 + "1" + "}" * 32, "verdict"), ('{"a":' * 33 + "1" + "}" * 33, "JSON_SYNTAX"),
                  ('{"a":1}', "verdict")]:
    if expected(raw) != want:
        print("SELF-CHECK FAILED", raw[:60], expected(raw), want)
        sys.exit(2)

data = json.load(open(sys.argv[1]))
cases = data["cases"]
if not cases:
    print("no cases")
    sys.exit(1)
bad = [c for c in cases if expected(c["raw"]) != outcome(c)]
# The plain target ranges must be accepted, so a verdict regenerated from a broken
# withinRules can't pass (test re-audit of 520b106, L-5; verdict content is otherwise TypeScript-only).
CANONICAL = {('{"kind":"open","left":-800,"right":0}', -400), ('{"kind":"open","left":-700,"right":100}', -300)}
seen = 0
for c in cases:
    if (c["raw"], c["point"]) in CANONICAL:
        seen += 1
        if c["result"].get("verdict") != {"ok": True}:
            bad.append(c)
if seen < len(CANONICAL):
    print("canonical cases missing")
    sys.exit(1)
for c in bad:
    print("MISMATCH", c["raw"][:120], "want", expected(c["raw"]), "got", outcome(c))
print(f"{len(cases)} cases, {len(bad)} mismatches")
sys.exit(1 if bad else 0)
