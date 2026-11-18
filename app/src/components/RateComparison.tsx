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
              className={`flex flex-col gap-1 rounded-2xl border p-4 transition-colors ${chosen ? "border-chalk/60 bg-sunken" : "border-line"}`}
            >
              <div className="flex items-center justify-between">
                <span className="eyebrow">{v.name}</span>
                {chosen && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
              </div>
              <div className={`text-2xl font-semibold tracking-tight tabular-nums ${chosen ? "" : "text-muted"}`}>{formatBps(v.rateBps)}</div>
              {chosen && <div className="text-xs text-accent">Cheapest available, used for this payment</div>}
              {v.borrowable === false && (
                <div className="text-xs text-faint">Comparison only: Ardoise has no {v.name} adapter yet</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-faint">Live USDC borrow rates (APR) against cirBTC on Arc mainnet.</p>
    </div>
  );
}
