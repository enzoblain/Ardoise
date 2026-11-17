import { arcClient } from "@/lib/arc";

// Read the chain on every request so the status reflects Arc right now.
export const dynamic = "force-dynamic";

/** Home page: shows the pitch and whether Arc mainnet is reachable. */
export default async function Home() {
  const blockNumber = await arcClient.getBlockNumber().catch(() => null);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Ardoise</h1>
      <p>Pay anyone, on any chain, with your bitcoin without selling it.</p>
      <p className="font-mono text-sm opacity-70">
        {blockNumber === null
          ? "Arc mainnet unreachable"
          : `Arc mainnet · block ${blockNumber.toString()}`}
      </p>
    </main>
  );
}
