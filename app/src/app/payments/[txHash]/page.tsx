import { notFound } from "next/navigation";
import { isHash } from "viem";
import { DeliveryTracker } from "@/components/DeliveryTracker";

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
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Payment</h1>
      <DeliveryTracker key={txHash} sourceTxHash={txHash} />
    </main>
  );
}
