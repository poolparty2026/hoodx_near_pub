/** Shown on every screen that uses made-up data, so nobody mistakes it for a real strategy. */
export function SampleBanner() {
  return (
    <p className="mt-3 rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy">
      Sample data. Not a real strategy, and nothing here is read from a chain.
    </p>
  );
}
