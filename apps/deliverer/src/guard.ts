// Testnet-only guard (D57): an exact-host allowlist, not a substring match
// (so "testnet.evil.com" or "rpc.mainnet.near.org/?testnet" don't pass).
export const ALLOWED_RPC_HOSTS = ["rpc.testnet.near.org", "rpc.testnet.fastnear.com", "test.rpc.fastnear.com", "localhost", "127.0.0.1"];

export function assertTestnetRpc(rpcUrl: string): void {
  let u: URL;
  try { u = new URL(rpcUrl); } catch { throw new Error("DELIVERER: RPC url is not a URL"); }
  if (u.username !== "" || u.password !== "" || !ALLOWED_RPC_HOSTS.includes(u.hostname) ||
      (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")))) {
    throw new Error("DELIVERER: refusing a non-allowlisted RPC (D57: testnet and sandbox only)");
  }
}
