# Gate 5: how is the fee split defined?

**Owner:** Lead. **Due:** 7 November 2026.

## Question

The October overview gives fee numbers that don't add up. The brief says to decide the real order, show exact amounts in the demo, and not show any number that isn't settled.

## What the overview says

1. "Strategy fee: 5% of the LP fees a strategy earns. Creator gets 7%, joiners keep 88%."
2. The split bar: "Joiners 88%, Creator 7% (lavender), Poolside 5% platform (peach)". The MVP loop says "7% to creator, 5% to Poolside, 88% to joiners".
3. "Automation fee: 8% of LP fees collected when a guardrail acts, on any position."

Statement 1 calls 5% the strategy fee and then gives the creator 7%, so 5% can't be the total. Statement 2 adds up to 100%. Statement 3 takes a further 8% of some fees, so joiners would get less than the 88% promised in statement 2.

## Proposal

**For the hackathon:**

- Out of the LP fees a strategy earns: **creator 7%, Poolside 5%, joiners 88%**.
- **Automation fee: 0.** Turn it off for the hackathon, so the three numbers on screen are the whole story.
- **Cuts come from fees collected, never from deposits (D15).** The creator and Poolside get 7% and 5% of the fees Rhea actually paid the strategy, in each token. If no fees were collected, they get nothing. Cuts are taken even if price moves caused an overall loss, and the README and demo say so plainly.
- **Per token, in held tokens (D13):** cuts are taken from the fees actually collected from Rhea in each token, and every payout is rounded down in that token's smallest unit. The rounding remainder, at most one unit per joiner per token, stays in the contract as unallocatable dust.

The contract takes these as basis points (`creator_bps = 700`, `platform_bps = 500`; the automation fee was removed from the design until it is specified), so changing the decision later only changes configuration.

## Worked example

A strategy that holds USDC and NEAR at close (amounts shown to 6 decimals). Two joiners hold 60% and 40% of the shares. Over the run, the strategy collected 6.345678 USDC and 0.500000 NEAR in fees from Rhea.

| Line | USDC | NEAR |
|---|---|---|
| Balance at settlement | 520.345678 | 12.000000 |
| Fees collected | 6.345678 | 0.500000 |
| Creator, 7% of fees (rounded down) | 0.444197 | 0.035000 |
| Poolside, 5% of fees (rounded down) | 0.317283 | 0.025000 |
| Joiner pool (balance minus cuts) | 519.584198 | 11.940000 |
| Joiner A, 60% (rounded down) | 311.750518 | 7.164000 |
| Joiner B, 40% (rounded down) | 207.833679 | 4.776000 |
| Remainder (stays as dust) | 0.000001 | 0.000000 |

Every amount is rounded down, so payouts never exceed the balance. The rounding remainder, at most one smallest unit per joiner per token, stays in the contract as unallocatable dust. The architecture (section 5.9) is the normative version of this formula.

## What depends on gate 3

If Rhea reports fees separately when they are claimed or a position is removed, cuts use those fees (the normal mode). If not, the fallback mode takes cuts only from USDC, on the USDC balance above the USDC deposited, which also includes price movement between the two tokens. Then a strategy that earned fees but lost more to price movement pays nobody a cut, and one that gained from price movement pays a cut on that gain. The README has to say which measure is used.

## Decision

- [x] Accepted for now, as long as it can be adjusted later (D2 in `docs/DECISIONS.md`). The contract keeps the split in configuration, so a new strategy can use different numbers without a code change.

**Sign-off:** Accepted by the lead, 5 November 2026.
