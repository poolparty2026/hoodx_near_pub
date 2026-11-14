import type { JsonValue } from "../src/json.ts";
import { validateRules, type RulesV1 } from "../src/schema.ts";

export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const WNEAR = "wrap.near";
export const POOL_100 = `${USDC}|${WNEAR}|100`;
export const POOL_2000 = `${USDC}|${WNEAR}|2000`;
/** base64 of 32 zero bytes. */
export const SALT = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function rawRules(over: Record<string, JsonValue> = {}): { [key: string]: JsonValue } {
  return {
    version: 1,
    pool: POOL_100,
    quote_token: USDC,
    range: { width_bps: 800, centre: "mid" },
    take_profit_bps: 300,
    stop_loss_bps: 1000,
    close_after_s: 432_000,
    salt: SALT,
    ...over,
  };
}
export function rules(over: Record<string, JsonValue> = {}): RulesV1 {
  return validateRules(rawRules(over));
}
