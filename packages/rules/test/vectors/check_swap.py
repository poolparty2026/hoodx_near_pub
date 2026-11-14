"""Independent check of test/vectors/swap.json against the true price 1.0001^point,
with 400-digit decimals and no code shared with packages/rules.
Run: python3 -I test/vectors/check_swap.py test/vectors/swap.json

Two checks per vector:
1. Exact: the documented algorithm (ARCHITECTURE section 4 and the price.ts and
   swap.ts headers), reimplemented here from the spec, must give the same integer.
   This port follows the same spec, so it would share a misreading of it; check 2
   is the part that is independent of the spec.
   This catches a missed floor or a wrong loop even if the vectors were
   regenerated from wrong code.
2. Against the true price: the result must be within one unit plus 2.2e-33
   relative of the exact real answer.
The library uses priceQ128(|point|), which is floored at every step and sits at
or below the true 1.0001^|point|, within 2.1e-33 relative over 0..800,000
(measured 6 November 2026). For negative points the effective ratio
2^128 / priceQ128(|point|) therefore sits at or above the true price, by the same
relative amount. At u128::MAX that tolerance is about 750,000 units (the largest
error in the vectors is 111), so check 1 is what pins the integers. Against the library's own price the swap never overshoots;
the property test checks that.

The script also checks itself: a vector moved by one unit must fail."""
import copy, json, sys
from decimal import Decimal, getcontext
getcontext().prec = 400
REL = Decimal("2.2e-33")
Q = 128
BASE = (10001 << Q) // 10000


def price_q128(n):
    """1.0001^n in Q128 for n >= 0: binary exponentiation, every product floored."""
    assert 0 <= n <= 800_000
    result, b = 1 << Q, BASE
    while n:
        if n & 1:
            result = (result * b) >> Q
        b = (b * b) >> Q
        n >>= 1
    return result


def spec_swap(x, y, nx, ny, point):
    a, b = (price_q128(point), 1 << Q) if point >= 0 else (1 << Q, price_q128(-point))
    cross = x * ny - y * nx
    if cross == 0:
        return None
    denom = ny * b + nx * a
    if cross > 0:
        d = cross * b // denom
        return None if d == 0 else {"tokenIn": "x", "amountIn": str(d)}
    d = -cross * a // denom
    return None if d == 0 else {"tokenIn": "y", "amountIn": str(d)}


def check(v):
    x, y = int(v["holdings"]["x"]), int(v["holdings"]["y"])
    nx, ny = int(v["need"]["x"]), int(v["need"]["y"])
    got = v["result"]
    if spec_swap(x, y, nx, ny, v["point"]) != got:
        return False
    p = Decimal("1.0001") ** v["point"]
    cross = x * ny - y * nx
    if cross == 0:
        return got is None
    if cross > 0:
        tok, exact = "x", Decimal(cross) / (ny + nx * p)
    else:
        tok, exact = "y", Decimal(-cross) * p / (ny + nx * p)
    amt = int(got["amountIn"]) if got else 0
    ok = (got is None or got["tokenIn"] == tok) and abs(exact - amt) <= 1 + exact * REL
    # A one-sided need swaps exactly everything held of the other token.
    if nx == 0:
        ok = ok and amt == x
    if ny == 0:
        ok = ok and amt == y
    return ok


# The price itself: at or below the true value, within 2.1e-33 relative, at the
# bounds, every 2^k - 1 and k * 50,000 (test re-audit L-4).
for n in sorted({0, 1, 6932, 401_452, 524_287, 524_288, 800_000} | {2**k - 1 for k in range(1, 20)} | {k * 50_000 for k in range(17)}):
    true = Decimal("1.0001") ** n * (Decimal(2) ** Q)
    err = (true - price_q128(n)) / true
    if not (0 <= err <= Decimal("2.1e-33")):
        print("PRICE OUT OF BOUND", n, err)
        sys.exit(1)

vectors = json.load(open(sys.argv[1]))
bad = [v for v in vectors if not check(v)]
for v in bad:
    print("MISMATCH", v)
# Self-check: the largest two-sided result, changed in each way below, must be caught.
two_sided = (v for v in vectors if v["result"] and v["need"]["x"] != "0" and v["need"]["y"] != "0")
big = copy.deepcopy(max(two_sided, key=lambda v: int(v["result"]["amountIn"])))
for name, change in [
    ("one unit low", lambda r: {**r, "amountIn": str(int(r["amountIn"]) - 1)}),
    ("one unit high", lambda r: {**r, "amountIn": str(int(r["amountIn"]) + 1)}),
    ("token swapped", lambda r: {**r, "tokenIn": "y" if r["tokenIn"] == "x" else "x"}),
    ("result null", lambda r: None),
]:
    bad_v = copy.deepcopy(big)
    bad_v["result"] = change(bad_v["result"])
    if check(bad_v):
        print(f"SELF-CHECK FAILED: a vector with {name} passed")
        sys.exit(2)
print(f"{len(vectors)} vectors, {len(bad)} mismatches")
sys.exit(1 if bad else 0)
