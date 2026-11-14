"""Independent check of test/vectors/swap_floor.json, written from ARCHITECTURE 5.6 and
section 4 (no code shared with packages/rules).
Run: python3 -I test/vectors/check_swap_floor.py test/vectors/swap_floor.json

For each vector it recomputes the swap minimum from the spec:
  max(floor(quote_out * (10000 - slip) / 10000),
      floor(value_ref(amount_in) * (10000 - fee_bps - slip) / 10000))
with fee_bps = fee_tier / 100 and value_ref the input converted into the output token
at ref_point (price = token_y per token_x = 1.0001^point in Q128, every product
floored), saturated at u128::MAX, and checks the `larger` label. It also checks the
reference value against the exact rational price: within 2.2e-33 relative plus one unit.
The script checks itself: a vector moved by one unit must fail."""
import copy, json, sys
from fractions import Fraction

Q = 128
BASE = (10001 << Q) // 10000
U128_MAX = (1 << 128) - 1
FEE_TIERS = {100, 400, 1000, 2000, 10000}


def price_q128(n):
    assert 0 <= n <= 800_000
    result, b = 1 << Q, BASE
    while n:
        if n & 1:
            result = (result * b) >> Q
        b = (b * b) >> Q
        n >>= 1
    return result


def convert(amount, e):
    """amount * 1.0001^e, floored: multiply for e >= 0, divide by price(-e) below."""
    if e >= 0:
        return (amount * price_q128(e)) >> Q
    return (amount << Q) // price_q128(-e)


def value_ref(c):
    p = c["ref_point"]
    # Into the base token when the input is the quote token: quote is x means y = x * price.
    if c["input_is_quote"]:
        e = p if c["quote_is_x"] else -p
    else:
        e = -p if c["quote_is_x"] else p
    return e, min(convert(int(c["amount_in"]), e), U128_MAX)


def check(c):
    assert c["fee_tier"] in FEE_TIERS and 11 <= c["slip_bps"] <= 100
    fee, slip = c["fee_tier"] // 100, c["slip_bps"]
    e, ref = value_ref(c)
    fq = int(c["quote_out"]) * (10000 - slip) // 10000
    fr = ref * (10000 - fee - slip) // 10000
    want = max(fq, fr)
    label = "quote" if fq > fr else "reference" if fr > fq else "tie"
    errs = []
    if int(c["min_out"]) != want:
        errs.append(f"min_out {c['min_out']} != {want}")
    if c["larger"] != label:
        errs.append(f"larger {c['larger']} != {label}")
    if abs(e) <= 5000 and ref < U128_MAX:
        exact = Fraction(int(c["amount_in"])) * Fraction(10001, 10000) ** e
        if abs(Fraction(ref) - exact) > exact * Fraction(22, 10**34) + 1:
            errs.append("reference value far from the exact price")
    return errs


def main(path):
    d = json.load(open(path))
    bad = 0
    for c in d["cases"]:
        for e in check(c):
            bad += 1
            print(c["name"], ":", e)
    # Self-check: moving a result by one unit must be caught.
    m = copy.deepcopy(d["cases"][0])
    m["min_out"] = str(int(m["min_out"]) + 1)
    assert check(m), "self-check failed"
    print(f"{len(d['cases'])} cases, {bad} mismatches")
    sys.exit(1 if bad else 0)


main(sys.argv[1])
