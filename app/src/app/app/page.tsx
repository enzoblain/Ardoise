import Link from "next/link";
import { AccountScreen } from "@/components/AccountScreen";
import { LogoMark } from "@/components/LogoMark";
import { arcClient } from "@/lib/arc";
import { network } from "@/lib/network";
import { memo } from "@/lib/cache";
import { readVenueRates } from "@/lib/venues";

// Rendered per request, but its chain reads are shared between visitors:
// rates for 15 s, the block shown in the header for 5 s, the chain id for an
// hour. When Arc cannot be read, the last good value is served for a while.
export const dynamic = "force-dynamic";
const rates = memo(15_000, 10 * 60_000, readVenueRates);
const blockNumber = memo(5_000, 60_000, () => arcClient.getBlockNumber());
const chainId = memo(60 * 60_000, 24 * 60 * 60_000, () => arcClient.getChainId());

/**
 * App page (`/app`): the pay screen and the statement, fed with live venue rates
 * from Arc mainnet, and the status of the Arc network the app is set to.
 */
export default async function AppPage() {
  const [venues, block, chain] = await Promise.all([rates().catch(() => null), blockNumber().catch(() => null), chainId().catch(() => null)]);
  // ARC_RPC_URL is set by hand and may point at the other network.
  const wrongNetwork = chain !== null && chain !== network.arc.chain.id;
  const status = wrongNetwork
    ? `ARC_RPC_URL serves chain ${chain}, expected ${network.arc.label} (${network.arc.chain.id})`
    : block === null
      ? `${network.arc.label} unreachable`
      : `${network.arc.label} · block ${block.toString()}`;

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoMark size={28} />
            Ardoise
          </Link>
        </h1>
        <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-xs text-muted">
          <span
            className={`h-1.5 w-1.5 rounded-full ${wrongNetwork || block === null ? "bg-danger" : "bg-accent"}`}
            aria-hidden
          />
          {status}
        </span>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 pb-16">
        {venues ? (
          <AccountScreen venues={venues} />
        ) : (
          <p className="card text-danger">Could not read the lending rates from Arc mainnet. Try again in a moment.</p>
        )}
      </main>
    </div>
  );
}
