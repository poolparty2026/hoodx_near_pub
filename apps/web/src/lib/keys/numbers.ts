export class ViewError extends Error {}
const CANON = /^(0|[1-9][0-9]*)$/;
const read = (v: unknown, what: string, max: bigint): bigint => {
  if (typeof v !== "string" || !CANON.test(v)) throw new ViewError(`${what}: not a canonical decimal string`);
  const n = BigInt(v);
  if (n > max) throw new ViewError(`${what}: out of range`);
  return n;
};
export const readU64 = (v: unknown, what: string): bigint => read(v, what, (1n << 64n) - 1n);
export const readU128 = (v: unknown, what: string): bigint => read(v, what, (1n << 128n) - 1n);
