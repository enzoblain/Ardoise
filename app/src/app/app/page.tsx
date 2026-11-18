import { AccountScreen } from "@/components/AccountScreen";
import { AppHeader } from "@/components/AppHeader";
import { arcClient } from "@/lib/arc";
import { network } from "@/lib/network";
import { parseRequest } from "@/lib/paymentRequest";
import { readVenueRates } from "@/lib/venues";

// Rates move with every block; read them on each request.
export const dynamic = "force-dynamic";

/**
 * App page (`/app`): the pay screen and the statement, fed with live venue rates
 * from Arc mainnet, and the status of the Arc network the app is set to. A
 * payment request link (`/app?to=…`, see `lib/paymentRequest.ts`) fills in the
 * pay screen.
 */
export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const request = parseRequest(await searchParams);
  const [venues, blockNumber, chainId] = await Promise.all([
    readVenueRates().catch(() => null),
    arcClient.getBlockNumber().catch(() => null),
    arcClient.getChainId().catch(() => null),
  ]);
  // ARC_RPC_URL is set by hand and may point at the other network.
  const wrongNetwork = chainId !== null && chainId !== network.arc.chain.id;
  const status = wrongNetwork
    ? `ARC_RPC_URL serves chain ${chainId}, expected ${network.arc.label} (${network.arc.chain.id})`
    : blockNumber === null
      ? `${network.arc.label} unreachable`
      : `${network.arc.label} · block ${blockNumber.toString()}`;

  return (
    <div className="min-h-screen">
      <AppHeader
        current="pay"
        status={
          <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-xs text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full ${wrongNetwork || blockNumber === null ? "bg-danger" : "bg-accent"}`}
              aria-hidden
            />
            {status}
          </span>
        }
      />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 pb-16">
        <h1 className="sr-only">Ardoise: pay with your bitcoin</h1>
        {venues ? (
          <AccountScreen venues={venues} request={request} />
        ) : (
          <p className="card text-danger">Could not read the lending rates from Arc mainnet. Try again in a moment.</p>
        )}
      </main>
    </div>
  );
}
