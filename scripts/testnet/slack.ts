// The refund assertion tolerates the gas of the refund_key call itself. A loose tolerance would hide a
// real shortfall, so it is bounded: the slack must stay below a quarter of the key price.
export function resolveGasSlack(run: { gasSlackYocto?: string | number; gasSlack?: string | number }, price: bigint): bigint {
  const raw = run.gasSlackYocto ?? run.gasSlack ?? 10n ** 22n;
  let slack: bigint;
  try { slack = BigInt(raw); } catch { throw new Error("E2E FAILED: gas slack is not an integer"); }
  if (slack < 0n) throw new Error("E2E FAILED: gas slack must not be negative");
  if (slack >= price / 4n) throw new Error("E2E FAILED: gas slack must stay below a quarter of the price, or the refund assertion proves nothing");
  return slack;
}
