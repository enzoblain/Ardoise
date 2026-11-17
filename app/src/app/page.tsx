import { arcClient } from "@/lib/arc";
import { network } from "@/lib/network";

// Read the chain on every request so the status reflects Arc right now.
export const dynamic = "force-dynamic";

/** Home page: shows the pitch and whether Arc is reachable. */
export default async function Home() {
  const [blockNumber, chainId] = await Promise.all([
    arcClient.getBlockNumber().catch(() => null),
    arcClient.getChainId().catch(() => null),
  ]);
  // ARC_RPC_URL is set by hand and may point at the other network.
  const wrongNetwork = chainId !== null && chainId !== network.arc.chain.id;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Ardoise</h1>
      <p>Pay anyone, on any chain, with your bitcoin without selling it.</p>
      <p className="font-mono text-sm opacity-70">
        {wrongNetwork
          ? `ARC_RPC_URL serves chain ${chainId}, expected ${network.arc.label} (${network.arc.chain.id})`
          : blockNumber === null
            ? `${network.arc.label} unreachable`
            : `${network.arc.label} · block ${blockNumber.toString()}`}
      </p>
    </main>
  );
}
