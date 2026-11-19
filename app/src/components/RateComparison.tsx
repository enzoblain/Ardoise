import { venueUsable, type Venue, type VenueOption } from "@/lib/ardoise";
import { formatBps, formatUsdcCompact, formatUsdc } from "@/lib/format";

/**
 * The venues side by side: live rate, liquidity and whether the guard lets
 * this payment borrow there. The recommended venue (`bestVenue`: the
 * cheapest one the guard allows) is badged and selected by default; when the
 * account can borrow on more than one venue, the user picks where the payment
 * borrows (`payVia`). Venues the account cannot borrow from yet are shown for
 * comparison.
 *
 * @param props.venues Venues with their live rates.
 * @param props.options Per-venue figures for this payment, once quoted.
 * @param props.borrow Amount the payment borrows, fees included.
 * @param props.recommendedId Id of the venue `bestVenue` returned, if any.
 * @param props.chosenId Id of the venue the payment would borrow from.
 * @param props.onChoose Called with a venue id when the user picks one;
 *   omitted when there is nothing to choose.
 */
export function RateComparison({
  venues,
  options,
  borrow,
  recommendedId,
  chosenId,
  onChoose,
}: {
  venues: Venue[];
  options?: VenueOption[];
  borrow?: bigint;
  recommendedId?: string;
  chosenId?: string;
  onChoose?: (venueId: string) => void;
}) {
  const borrowable = venues.filter((v) => v.borrowable !== false);
  const cheapest = borrowable.reduce<Venue | undefined>((best, v) => (!best || v.rateBps < best.rateBps ? v : best), undefined);
  const selectable = onChoose !== undefined && borrowable.length > 1;
  return (
    <div className="flex flex-col gap-2">
      {selectable && <span className="eyebrow">Borrow from</span>}
      <ul className="grid grid-cols-2 gap-2" role={selectable ? "radiogroup" : undefined} aria-label={selectable ? "Borrow from" : undefined}>
        {venues.map((v) => {
          const chosen = v.id === chosenId;
          const recommended = v.id === recommendedId;
          const option = options?.find((o) => o.venue.id === v.id);
          const body = (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">{v.name}</span>
                {chosen && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
              </div>
              <div className={`text-2xl font-semibold tracking-tight tabular-nums ${chosen ? "" : "text-muted"}`}>{formatBps(v.rateBps)}</div>
              {recommended && (
                <div className="text-xs font-medium text-accent">
                  Recommended{v.id === cheapest?.id ? " · cheapest" : " · cheapest you can use"}
                </div>
              )}
              {v.borrowable === false ? (
                <div className="text-xs text-faint">Comparison only: Ardoise has no {v.name} adapter yet</div>
              ) : (
                <>
                  <div className="text-xs text-muted">{formatUsdcCompact(v.available)} USDC available</div>
                  {option && borrow !== undefined && <GuardStatus option={option} borrow={borrow} />}
                </>
              )}
            </>
          );
          const frame = `flex h-full w-full flex-col gap-1 rounded-2xl border p-4 text-left transition-colors ${chosen ? "border-chalk/60 bg-sunken" : "border-line"}`;
          return (
            <li key={v.id}>
              {selectable && v.borrowable !== false ? (
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  onClick={() => onChoose(v.id)}
                  className={`${frame} hover:border-chalk/40`}
                >
                  {body}
                </button>
              ) : (
                <div className={frame}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-faint">Live USDC borrow rates (APR) against cirBTC on Arc mainnet.</p>
    </div>
  );
}

function GuardStatus({ option, borrow }: { option: VenueOption; borrow: bigint }) {
  if (!option.liquidityOk) return <div className="text-xs text-danger">Not enough liquidity for this payment</div>;
  if (option.allowed === null) return <div className="text-xs text-faint">No guard set yet</div>;
  if (venueUsable(option, borrow)) return <div className="text-xs text-chalk">Guard OK for this payment</div>;
  if (option.allowed === 0n) return <div className="text-xs text-danger">Guard refuses: no margin here</div>;
  return <div className="text-xs text-danger">Guard refuses: up to {formatUsdc(option.allowed)} USDC here</div>;
}
