// What this version does not check. Rendered under every verdict screen (check pages and samples) so "Matching" is never read as more
// than it is. Plain text only (EC-W04).
export const NOT_CHECKED = [
  "Valuation: stop loss and take profit use the pool's spot point at each sampled block (Q15). The page cannot check that this price was fair; a price moved across the whole confirmation span would pass.",
  "That the deployed code is a reproducible build of the audited commit (only a pinned hash is compared, when one is published).",
  "That the account was created in the single creating transaction, and that principal equals the sum of the funding events.",
  "That the split of fees followed the stated percentage.",
  "Refusals by public limits are shown as context. They are not yet recomputed from the record, so they are never counted as an excuse.",
  "Only the sampled blocks are compared: a key added and removed between two samples, or a close condition that comes and goes between them, is not seen.",
  "The decision log chain, unless the agent records chain heads (a run without them has no chain to check).",
  "That the creation block and the agent's history are as recorded; the recorded runs supply a stand-in creation block.",
];

export function NotChecked() {
  return (
    <>
      <h2 className="mt-8 text-lg font-bold">Not checked in this version</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
        {NOT_CHECKED.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </>
  );
}
