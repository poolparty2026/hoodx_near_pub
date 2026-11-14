import { expect } from "vitest";
import { NearError } from "../src/errors.ts";

/**
 * `toRefuse(msg)`: the value (a rejection, or a function that throws) is a NearError whose
 * code is the message's prefix and whose message is exactly `msg`. Vitest's toThrow("...")
 * only checks a substring, and a regex only checks the text; this also catches a refusal
 * re-thrown as a plain Error (EC-V08: never a raw exception).
 */
expect.extend({
  toRefuse(received: unknown, msg: string) {
    let e: unknown = received;
    if (typeof received === "function") {
      e = undefined;
      try { (received as () => unknown)(); } catch (x) { e = x; }
    }
    const code = msg.slice(0, msg.indexOf(":"));
    const pass = e instanceof NearError && e.code === code && e.message === msg;
    return {
      pass,
      message: () => `expected a NearError ${JSON.stringify(msg)}, got ${e instanceof Error ? `${e.constructor.name} ${JSON.stringify(e.message)}` : String(e)}`,
    };
  },
});

declare module "vitest" {
  interface Assertion<T> { toRefuse(msg: string): T }
  interface AsymmetricMatchersContaining { toRefuse(msg: string): unknown }
}
