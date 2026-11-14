import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGasSlack } from "./slack.ts";

const price = 100_000_000_000_000_000_000_000n; // 0.1 NEAR

test("default is 0.01 NEAR; gasSlackYocto wins over gasSlack", () => {
  assert.equal(resolveGasSlack({}, price), 10n ** 22n);
  assert.equal(resolveGasSlack({ gasSlack: "3" }, price), 3n);
  assert.equal(resolveGasSlack({ gasSlackYocto: "2", gasSlack: "3" }, price), 2n);
  assert.equal(resolveGasSlack({ gasSlackYocto: 5 }, price), 5n);
});

test("the sandbox's 0.02 NEAR passes; a quarter of the price and above is refused, one below passes", () => {
  assert.equal(resolveGasSlack({ gasSlackYocto: "20000000000000000000000" }, price), 2n * 10n ** 22n);
  assert.equal(resolveGasSlack({ gasSlackYocto: (price / 4n - 1n).toString() }, price), price / 4n - 1n);
  assert.throws(() => resolveGasSlack({ gasSlackYocto: (price / 4n).toString() }, price), /below a quarter of the price/);
  assert.throws(() => resolveGasSlack({ gasSlack: "30000000000000000000000" }, price), /below a quarter of the price/); // a 0.03 NEAR shortfall hidden
});

test("garbage and negatives are refused", () => {
  assert.throws(() => resolveGasSlack({ gasSlackYocto: "abc" }, price), /not an integer/);
  assert.throws(() => resolveGasSlack({ gasSlackYocto: "-1" }, price), /must not be negative/);
});
