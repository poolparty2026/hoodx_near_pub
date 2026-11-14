"""Independent check of test/vectors/target_range.json with Python's floor division
(no code shared with packages/rules). Shared with the Rust tests: the Rust mirror
must use floor and ceiling division toward -infinity and +infinity, not `/`.
Run: python3 -I test/vectors/check_target_range.py test/vectors/target_range.json"""
import json, sys
SPACING = {100: 1, 400: 8, 1000: 20, 2000: 40, 10000: 200}
MIN, MAX = -800_000, 800_000
bad = 0
vectors = json.load(open(sys.argv[1]))
for v in vectors:
    d, half, c = SPACING[v["tier"]], v["width_bps"] // 2, v["centre"]
    left = ((c - half) // d) * d
    right = -((-(c + half)) // d) * d
    want = {"left": left, "right": right} if (left >= MIN and right <= MAX and left <= c < right) else None
    if v["range"] != want:
        bad += 1
        print("MISMATCH", v, "want", want)
# Each vector must also tell floor division from truncation, unless it is a bound case.
def trunc(a, b): return int(a / b)
discriminating = sum(1 for v in vectors if v["range"] and (
    trunc(v["centre"] - v["width_bps"] // 2, SPACING[v["tier"]]) * SPACING[v["tier"]] != v["range"]["left"]
    or -trunc(-(v["centre"] + v["width_bps"] // 2), SPACING[v["tier"]]) * SPACING[v["tier"]] != v["range"]["right"]))
print(f"{len(vectors)} vectors, {bad} mismatches, {discriminating} discriminate floor from truncation")
sys.exit(1 if bad or discriminating < 6 else 0)
