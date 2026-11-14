import type { OpenResult, BuyState } from "@/lib/keys/flow.ts";

export type DataKind = "sample" | "recorded" | "testnet";
const KIND_TEXT: Record<DataKind, string> = {
  sample: "Sample data. Made up for this screen; nothing here is read from a chain.",
  recorded: "Recorded data. Read from a saved recording, not live from a chain.",
  testnet: "Testnet data. Test tokens only, no real funds.",
};
export const DataBanner = ({ kind }: { kind: DataKind }) => <p className="mt-3 rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy">{KIND_TEXT[kind]}</p>;

const near = (y: bigint): string => { const w = y / 10n ** 24n, f = (y % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, ""); return `${w}${f ? "." + f : ""} NEAR`; };

export function BuyStatus({ state }: { state: BuyState }) {
  switch (state.kind) {
    case "can_buy": return <p>The viewing key costs {near(state.deposit)}. This price is read from the testnet contract. Testnet only, no real tokens.</p>;
    case "sold_out": return <p>All viewing keys for this strategy are sold.</p>;
    case "waiting": return <p>Design of the key sale: after you pay, the deliverer is meant to send your key. This has run end to end in a local sandbox, by script and not through this page, and has not been run on testnet. If the key has not arrived by the deadline, you can ask for a refund.</p>;
    case "can_refund": return <p>Design of the key sale: once the delivery window has passed, you can ask for a refund.</p>;
    case "refunded": return <p>Design of the key sale: a refunded account cannot buy a second key for this strategy.</p>;
    case "delivered": return <p>Your key has arrived. Unlock it in this browser with your saved secret key.</p>;
  }
}

/** Rules are shown as plain text only (EC-W04, EC-W11): a React text node, never markup. */
export function UnlockedView({ result, rulesText }: { result: OpenResult; rulesText?: string }) {
  if (result.kind === "failed") {
    return (
      <div role="alert">
        <p>Could not unlock: {result.reason.replaceAll("_", " ")}. Nothing was shown.</p>
        {(result.reason === "rules_do_not_match" || result.reason === "does_not_open") && (
          <p className="mt-1 text-sm">The key you were sent does not open the rules that were committed. The contract cannot check a delivered key, and the payment goes to the creator when the key is delivered, so there is no refund after delivery.</p>
        )}
      </div>
    );
  }
  return (
    <div>
      <p className="font-bold">Hash check: the rules you decrypted match the rules hash committed on the testnet contract. This shows the rules are the ones committed; it is not proof that the agent followed them.</p>
      <pre className="card mt-2 overflow-x-auto p-3 text-xs whitespace-pre-wrap">{rulesText ?? JSON.stringify(result.rules, null, 2)}</pre>
    </div>
  );
}
