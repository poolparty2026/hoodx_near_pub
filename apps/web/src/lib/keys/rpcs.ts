/** The only RPC endpoints the follow flow talks to. The CSP connect-src is built from these (M1), and a test compares them. */
export const TESTNET_RPC = "https://rpc.testnet.near.org";
/** GUESS: test.rpc.fastnear.com serves testnet; confirm before the run. */
export const TESTNET_RPC_2 = "https://test.rpc.fastnear.com";
export const TESTNET_RPCS = [TESTNET_RPC, TESTNET_RPC_2] as const;
export const rpcOrigins = (): string[] => TESTNET_RPCS.map((u) => new URL(u).origin);
