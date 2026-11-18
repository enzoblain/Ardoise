import Link from "next/link";
import { AccountScreen } from "@/components/AccountScreen";
import { LogoMark } from "@/components/LogoMark";
import { arcClient } from "@/lib/arc";
import { network } from "@/lib/network";
import { readVenueRates } from "@/lib/venues";

// Rates move with every block; read them on each request.
export const dynamic = "force-dynamic";

/**
 * App page (`/app`): the pay screen and the statement, fed with live venue rates
 * from Arc mainnet, and the status of the Arc network the app is set to.
 */
export default async function AppPage() {
  const [venues, blockNumber, chainId] = await Promise.all([
    readVenueRates().catch(() => null),
    arcClient.getBlockNumber().catch(() => null),
    arcClient.getChainId().catch(() => null),
  ]);
  // ARC_RPC_URL is set by hand and may point at the other network.
  const wrongNetwork = chainId !== null && chainId !== network.arc.chain.id;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6 sm:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold">
          <Link href="/" className="flex w-fit items-center gap-3">
            <LogoMark size={36} />
            Ardoise
          </Link>
        </h1>
        <p className="opacity-80">Pay anyone, on any chain, with your bitcoin without selling it.</p>
      </header>
      {venues ? (
        <AccountScreen venues={venues} />
      ) : (
        <p className="text-red-600">Could not read the lending rates from Arc mainnet. Try again in a moment.</p>
      )}
      <footer className="font-mono text-xs opacity-60">
        {wrongNetwork
          ? `ARC_RPC_URL serves chain ${chainId}, expected ${network.arc.label} (${network.arc.chain.id})`
          : blockNumber === null
            ? `${network.arc.label} unreachable`
            : `${network.arc.label} · block ${blockNumber.toString()}`}
      </footer>
    </main>
  );
}
