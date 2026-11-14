"""Independent check of test/vectors/amounts.json (no code shared with packages/rules).
u128 and u64: the input must match 0|[1-9][0-9]* and be at most 2^128 - 1 or 2^64 - 1;
otherwise it is refused. ns_to_s: read as u64, then floor division by 10^9.
Run: python3 -I check_amounts.py amounts.json"""
import json, re, sys
MAX = {"u128": 2**128 - 1, "u64": 2**64 - 1, "ns_to_s": 2**64 - 1}
bad = 0
cases = json.load(open(sys.argv[1]))["cases"]
if len(cases) < 52:
    print(f"only {len(cases)} cases, expected at least 52")
    sys.exit(1)
for c in cases:
    t = c["input"]
    ok = bool(re.fullmatch(r"0|[1-9][0-9]*", t)) and int(t) <= MAX[c["fn"]]
    want = (str(int(t) // 10**9) if c["fn"] == "ns_to_s" else str(int(t))) if ok else None
    got = c["result"].get("value")
    # A refusal must be of the right class: range for a plain decimal above the maximum, format otherwise.
    if not ok:
        plain = bool(re.fullmatch(r"0|[1-9][0-9]*", t)) and len(t) <= len(str(MAX[c["fn"]]))
        cls = "fit in" if plain else "decimal"
        if cls not in c["result"].get("error", ""):
            got = "wrong refusal class: " + c["result"].get("error", "")
    if got != want:
        bad += 1
        print("MISMATCH", c, "want", want)
print(f"{len(cases)} cases, {bad} mismatches")
sys.exit(1 if bad else 0)
