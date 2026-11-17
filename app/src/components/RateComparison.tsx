import type { Venue } from "@/lib/ardoise";
import { formatBps } from "@/lib/format";

/**
 * Side-by-side borrow rates of the venues, highlighting the one the payment
 * would use. Venues the account cannot borrow from yet are shown for
 * comparison and labelled as such.
 *
 * @param props.venues Venues with their live rates.
 * @param props.chosenId Id of the venue `bestVenue` picked, if any.
 */
export function RateComparison({ venues, chosenId }: { venues: Venue[]; chosenId?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid grid-cols-2 gap-2">
        {venues.map((v) => {
          const chosen = v.id === chosenId;
          return (
            <li
              key={v.id}
              className={`rounded-lg border p-3 ${chosen ? "border-emerald-500 bg-emerald-500/10" : "border-black/10 dark:border-white/15"}`}
            >
              <div className="text-sm opacity-70">{v.name}</div>
              <div className="text-xl font-semibold tabular-nums">{formatBps(v.rateBps)}</div>
              {chosen && (
                <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  Cheapest available, used for this payment
                </div>
              )}
              {v.borrowable === false && (
                <div className="text-xs opacity-60">Comparison only: Ardoise has no {v.name} adapter yet</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs opacity-60">Live USDC borrow rates (APR) against cirBTC on Arc mainnet.</p>
    </div>
  );
}
