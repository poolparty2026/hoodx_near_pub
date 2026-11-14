// SAMPLE DATA ONLY. These strategies are made up to build the screens before the chain views exist.
// Nothing here is read from a chain. Amounts are display strings, never used in a calculation.
// No fee split number is shown anywhere (gate 5 is accepted for now; the pages do not rely on it).
export type StrategyStatus = "live" | "closed";

export interface SampleStrategy {
  readonly id: string;
  readonly name: string;
  readonly account: string;
  readonly status: StrategyStatus;
  readonly pool: string;
  readonly value: string;
  readonly publicPnl: string;
  readonly endsText: string;
  readonly rulesRevealed: boolean;
  readonly limits: readonly { readonly label: string; readonly value: string }[];
  readonly actions: readonly { readonly label: string; readonly when: string }[];
}

const POOL = "USDC / wNEAR · fee tier 0.01%";
const LIMITS = [
  { label: "Allowed pool", value: "USDC / wNEAR 0.01%" },
  { label: "Max slippage", value: "1.00%" },
  { label: "Actions per 24 h", value: "6" },
];

export const SAMPLE_STRATEGIES: readonly SampleStrategy[] = [
  { id: "steady-range", name: "Steady range", account: "steady.strat-12.near", status: "live", pool: POOL, value: "$1,240.00", publicPnl: "+$12.40",
    endsText: "Ends in 3d 4h", rulesRevealed: false, limits: LIMITS,
    actions: [{ label: "Open range", when: "2 h ago" }, { label: "Heartbeat", when: "11 min ago" }, { label: "Swap step", when: "5 h ago" }] },
  { id: "wide-and-slow", name: "Wide and slow", account: "wide.strat-4.near", status: "live", pool: POOL, value: "$860.00", publicPnl: "-$3.10",
    endsText: "Ends in 1d 22h", rulesRevealed: false, limits: LIMITS,
    actions: [{ label: "Open range", when: "1 d ago" }, { label: "Heartbeat", when: "4 min ago" }] },
  { id: "weekend-tight", name: "Weekend tight", account: "weekend.strat-9.near", status: "closed", pool: POOL, value: "$500.00", publicPnl: "+$4.80",
    endsText: "Closed 2 days ago", rulesRevealed: true, limits: LIMITS,
    actions: [{ label: "Open range", when: "6 d ago" }, { label: "Close", when: "2 d ago" }] },
];

export const findStrategy = (id: string): SampleStrategy | undefined => SAMPLE_STRATEGIES.find((s) => s.id === id);
