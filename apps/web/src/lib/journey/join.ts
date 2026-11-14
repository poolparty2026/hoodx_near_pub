// The simulated join. No transaction exists for it: the contract in this version is funded by the creator alone, so joining and
// exiting are replayed in page state only. Amounts are in USDC with at most 2 decimals; arithmetic is exact (bigint).
import rec from "./recorded.json";

export const USDC_DECIMALS = 6;
export const STEP_UNITS = 10n ** BigInt(USDC_DECIMALS - 2); // 2 decimals = multiples of 0.01 USDC
/** The recorded public limit max_principal bounds one simulated join (the recording has no per-joiner limit). */
export const MAX_JOIN_UNITS = BigInt(rec.maxPrincipal);
export const MAX_JOIN_TEXT = "500";

export type Parsed = { ok: true; units: bigint } | { ok: false; error: string };

export function parseAmount(text: string): Parsed {
  const t = text.trim();
  if (!/^[0-9]+(\.[0-9]*)?$/.test(t)) return { ok: false, error: "Type an amount in USDC, for example 25 or 25.50." };
  const [whole, frac = ""] = t.split(".");
  if (frac.length > 2) return { ok: false, error: "Use at most 2 decimals." };
  const units = BigInt(whole!) * 10n ** 6n + BigInt(frac.padEnd(6, "0"));
  if (units <= 0n) return { ok: false, error: "The amount must be more than zero." };
  if (units > MAX_JOIN_UNITS) return { ok: false, error: `The simulation accepts at most ${MAX_JOIN_TEXT} USDC, the recorded maximum principal of this strategy.` };
  return { ok: true, units };
}

export const usdc = (units: bigint): string => {
  const whole = units / 10n ** 6n, frac = (units % 10n ** 6n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac} USDC`;
};

/** Share of the pool as amount / (principal + amount), rounded down to 0.01 percent. */
export function shareBps(amount: bigint, principal: bigint): bigint { return (amount * 10_000n) / (principal + amount); }
export const pct = (bps: bigint): string => `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;

export interface Position { readonly amount: bigint; readonly shareBps: bigint }
export type JoinState = { readonly position: Position | null; readonly exited: boolean };
export const initialJoin: JoinState = { position: null, exited: false };
export function join(s: JoinState, amount: bigint): JoinState {
  if (s.position !== null) return s; // one simulated position at a time
  return { position: { amount, shareBps: shareBps(amount, BigInt(rec.principal)) }, exited: false };
}
export function exit(s: JoinState): { state: JoinState; returned: bigint } {
  if (s.position === null) return { state: s, returned: 0n };
  return { state: { position: null, exited: true }, returned: s.position.amount }; // the simulation returns exactly what was put in
}
