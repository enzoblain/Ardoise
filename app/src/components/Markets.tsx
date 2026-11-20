"use client";

import Link from "next/link";
import type { Venue } from "@/lib/ardoise";
import { formatBps, formatUsdcCompact } from "@/lib/format";
import { network } from "@/lib/network";

/** What each lender is, in a line, by venue id. */
const ABOUT: Record<string, { market: string; detail: string }> = {
  "aave-v4": {
    market: "Aave V4 · Main Spoke on Arc",
    detail: "Your cirBTC is supplied in your own Aave position; Ardoise borrows USDC against it through the Taker position manager.",
  },
  morpho: {
    market: "Morpho · cirBTC / USDC market",
    detail: "An isolated Morpho market: cirBTC as collateral, USDC lent by the market's suppliers at a rate set by its curve.",
  },
};

/**
 * The lending markets Ardoise can borrow from on Arc mainnet, side by side:
 * live borrow rate, liquidity and what each one is, with a way to pay from a
 * given market. Rates are the ones every payment compares.
 *
 * @param props.venues Venues with their live rates, read on the server.
 * @param props.pickHref Start of the link that opens the app on a venue; the venue id is appended.
 */
export function Markets({ venues, pickHref }: { venues: Venue[]; pickHref: string }) {
  const borrowable = venues.filter((v) => v.borrowable !== false);
  const cheapest = [...borrowable].sort((a, b) => a.rateBps - b.rateBps)[0];
  const explorer = network.arc.chain.blockExplorers?.default.url;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="eyebrow">Live on {network.arc.label}</p>
        <h2 className="text-lg font-semibold">Markets</h2>
        <p className="mt-1 text-sm text-muted">
          Where Ardoise can borrow USDC against your cirBTC. Each payment compares these rates and borrows from the
          cheapest one your margin allows, or the one you pick.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {venues.map((venue) => {
          const about = ABOUT[venue.id];
          const canBorrow = venue.borrowable !== false;
          return (
            <article key={venue.id} className="card flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{venue.name}</h3>
                  {about && <p className="text-xs text-muted">{about.market}</p>}
                </div>
                {venue.id === cheapest?.id && (
                  <span className="rounded-full border border-accent px-2.5 py-0.5 text-xs text-accent">Cheapest now</span>
                )}
              </div>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">Borrow rate (APR)</dt>
                  <dd className="font-mono text-lg">{formatBps(venue.rateBps)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">USDC available</dt>
                  <dd className="font-mono text-lg">{formatUsdcCompact(venue.available)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Collateral</dt>
                  <dd className="font-mono text-lg">cirBTC</dd>
                </div>
              </dl>
              {about && <p className="text-sm text-muted">{about.detail}</p>}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-1">
                {explorer && (
                  <a href={`${explorer}/address/${venue.address}`} className="text-xs text-muted underline-offset-4 hover:underline">
                    {canBorrow ? "Ardoise adapter" : "Contract"} ↗
                  </a>
                )}
                {canBorrow ? (
                  <Link href={`${pickHref}${venue.id}`} className="btn-primary px-4 py-2 text-sm">
                    Borrow on {venue.name}
                  </Link>
                ) : (
                  <span className="text-xs text-faint">Comparison only</span>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="text-xs text-faint">
        More markets later: EURC on Morpho, and other collateral (ETH, Treasury bills, gold) once Arc lists it.
      </p>
    </div>
  );
}
