import { FollowLive } from "@/components/FollowLive.tsx";

export default async function FollowPage({ params }: { params: Promise<{ strategy: string }> }) {
  const { strategy } = await params;
  return (
    <section className="py-6">
      <h1 className="text-2xl font-bold">Follow: viewing key</h1>
      <p className="mt-3 text-sm text-muted">Strategy: <span>{strategy}</span></p>
      <p className="mt-3 text-sm">A viewing key shows you the rules, and anyone who holds the key can copy them or pass them on. The strategy wallet is visible on Rhea, and public positions can leak part of the rules once a wallet is linked.</p>
      <p className="mt-2 text-sm">The contract holds your payment in escrow and pays the creator when the deliverer sends a key. The deliverer is a single account that you have to trust: it can send a key that does not open the rules, and after delivery there is no refund.</p>
      <div className="mt-3"><FollowLive strategy={strategy} /></div>
    </section>
  );
}
