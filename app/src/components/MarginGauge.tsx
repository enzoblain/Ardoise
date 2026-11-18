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
        <span className="eyebrow">Margin before liquidation on {venueName}</span>
        <span className="text-lg font-semibold tabular-nums">
          {formatPercent(before)}
          {after !== undefined && (
            <>
              {" → "}
              <span className={tooLow ? "text-danger" : ""}>{formatPercent(after)}</span>
            </>
          )}
        </span>
      </div>
      <div
        className="relative h-2.5 overflow-hidden rounded-full bg-line-strong"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        aria-label="Margin after the payment"
      >
        <div
          className={`absolute inset-y-0 left-0 transition-[width] duration-500 ${tooLow ? "bg-danger" : "bg-chalk"}`}
          style={{ width: `${Math.max(shown, 0) * 100}%` }}
        />
        {after !== undefined && after < before && (
          <div
            className="absolute inset-y-0 bg-chalk/25"
            style={{ left: `${Math.max(after, 0) * 100}%`, width: `${(before - Math.max(after, 0)) * 100}%` }}
          />
        )}
        {minimum !== undefined && (
          <>
            {/* Drawn last so the guard's floor stays visible over the fill. */}
            <div
              className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(135deg,rgba(248,113,113,0.5)_0_4px,transparent_4px_8px)]"
              style={{ width: `${minimum * 100}%` }}
            />
            <div className="absolute inset-y-0 w-0.5 bg-danger" style={{ left: `${minimum * 100}%` }} />
          </>
        )}
      </div>
      <p className="text-xs text-faint">
        {minimum === undefined
          ? "No position guard is deployed yet, so no payment can go through."
          : `Payments that would leave less than ${formatPercent(minimum)} (red zone) are refused.`}
      </p>
    </div>
  );
}
