import Link from "next/link";
import { notFound } from "next/navigation";
import { isHash } from "viem";
import { DeliveryTracker } from "@/components/DeliveryTracker";
import { LogoMark } from "@/components/LogoMark";

/**
 * Payment page: tracks the delivery of one cross-chain payment, identified
 * by the hash of its transaction on Arc.
 */
export default async function PaymentPage({
  params,
}: {
  params: Promise<{ txHash: string }>;
}) {
  const { txHash } = await params;
  if (!isHash(txHash)) notFound();

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <LogoMark size={28} />
          Ardoise
        </Link>
        <Link href="/app" className="text-sm text-muted transition-colors hover:text-foreground">
          ← Back to the app
        </Link>
      </header>
      <main className="mx-auto max-w-xl px-6 pt-8 pb-16">
        <div className="card flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Cross-chain payment</span>
            <h1 className="text-2xl font-semibold tracking-tight">Delivery</h1>
            <p className="break-all font-mono text-xs text-faint">{txHash}</p>
          </div>
          <DeliveryTracker key={txHash} sourceTxHash={txHash} />
        </div>
      </main>
    </div>
  );
}
