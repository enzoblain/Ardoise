import { formatPercent } from "@/lib/format";

/**
 * Bar showing how much margin the position keeps before liquidation, now and
 * after the payment, against the guard's minimum.
 *
 * @param props.venueName Venue whose position is shown.
 * @param props.before Margin now, between 0 and 1.
 * @param props.after Margin after the payment, if known.
 * @param props.minimum Lowest margin the guard lets a payment reach;
 *   undefined while no guard is set.
 */
export function MarginGauge({
  venueName,
  before,
  after,
  minimum,
}: {
  venueName: string;
  before: number;
  after?: number;
  minimum?: number;
}) {
  const shown = after ?? before;
  const tooLow = after !== undefined && minimum !== undefined && after < minimum;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm opacity-70">Margin before liquidation on {venueName}</span>
        <span className="font-semibold tabular-nums">
          {formatPercent(before)}
          {after !== undefined && (
            <>
              {" → "}
              <span className={tooLow ? "text-red-600" : ""}>{formatPercent(after)}</span>
            </>
          )}
        </span>
      </div>
      <div
        className="relative h-3 overflow-hidden rounded-full bg-black/10 dark:bg-white/15"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        aria-label="Margin after the payment"
      >
        <div
          className={`absolute inset-y-0 left-0 ${tooLow ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${Math.max(shown, 0) * 100}%` }}
        />
        {after !== undefined && after < before && (
          <div
            className="absolute inset-y-0 bg-emerald-500/35"
            style={{ left: `${Math.max(after, 0) * 100}%`, width: `${(before - Math.max(after, 0)) * 100}%` }}
          />
        )}
        {minimum !== undefined && (
          <>
            {/* Drawn last so the guard's floor stays visible over the fill. */}
            <div
              className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(135deg,rgba(239,68,68,0.55)_0_4px,transparent_4px_8px)]"
              style={{ width: `${minimum * 100}%` }}
            />
            <div className="absolute inset-y-0 w-0.5 bg-red-600" style={{ left: `${minimum * 100}%` }} />
          </>
        )}
      </div>
      <p className="text-xs opacity-60">
        {minimum === undefined
          ? "No position guard is deployed yet, so no payment can go through."
          : `Payments that would leave less than ${formatPercent(minimum)} (red zone) are refused.`}
      </p>
    </div>
  );
}
