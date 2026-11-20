"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { WAD, type ArdoiseClient, type Venue } from "@/lib/ardoise";
import { formatPercent } from "@/lib/format";
import { readReserve, type ReserveRead } from "@/lib/reserve";
import {
  AAVE_V4_CIRBTC,
  MORPHO_86,
  runStress,
  type CurvePoint,
  type Scenario,
  type StressPosition,
  type StressResult,
  type Thresholds,
} from "@/lib/stress";

const PRESETS: { label: string; scenario: Scenario }[] = [
  { label: "BTC −20%", scenario: { btcDrop: 0.2, ethDrop: 0.25 } },
  { label: "BTC −40% · ETH −50%", scenario: { btcDrop: 0.4, ethDrop: 0.5 } },
  { label: "BTC −60% · ETH −70%", scenario: { btcDrop: 0.6, ethDrop: 0.7 } },
];

// The deployed MarginGuard's thresholds, used while no guard is set.
const DEFAULT_THRESHOLDS: Thresholds = { minHealthFactor: 1.25, targetHealthFactor: 1.5 };

const SPEED_LABEL = { instant: "repaid at once by sweep()", automatic: "drawn by the keeper", manual: "by hand" } as const;

/**
 * "What if bitcoin falls" for the account: pick a scenario, see the health
 * factor with and without Ardoise, the reserve drawn in order, whether the
 * position survives and the liquidation penalty it avoids; then the reserve
 * asset by asset, with how far bitcoin can fall before it runs out. Read
 * only: everything is computed in the browser from the positions and
 * balances already on chain (`lib/stress.ts`).
 *
 * @param props.account The account client, for positions and thresholds.
 * @param props.venues Venues to read positions on.
 * @param props.owner Owner's wallet, for the reserve on Base.
 * @param props.accountAddress The Ardoise account.
 * @param props.version Bumped after each payment, to read the positions again.
 */
export function StressTest({
  account,
  venues,
  owner,
  accountAddress,
  version,
}: {
  account: ArdoiseClient;
  venues: Venue[];
  owner: Address;
  accountAddress: Address;
  version: number;
}) {
  const [scenario, setScenario] = useState<Scenario>(PRESETS[1].scenario);
  const [positions, setPositions] = useState<StressPosition[]>();
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [reserve, setReserve] = useState<ReserveRead>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    const borrowable = venues.filter((v) => v.borrowable !== false);
    Promise.all([
      Promise.all(borrowable.map((v) => account.health(v.id).then((h) => ({ venue: v, h })))),
      account.minHealthFactor(),
      account.targetHealthFactor(),
      readReserve(owner, accountAddress),
    ])
      .then(([healths, min, target, read]) => {
        if (!current) return;
        setPositions(
          healths
            .filter(({ h }) => h.debtUsd > 0n)
            .map(({ venue, h }) => ({
              venueName: venue.name,
              collateralUsd: wadToNumber(h.collateralUsd),
              debtUsd: wadToNumber(h.debtUsd),
              healthFactor: wadToNumber(h.healthFactor),
              liquidation: venue.id === "morpho" ? MORPHO_86 : AAVE_V4_CIRBTC,
            })),
        );
        if (min !== null && target !== null) setThresholds({ minHealthFactor: wadToNumber(min), targetHealthFactor: wadToNumber(target) });
        setReserve(read);
        setError(undefined);
      })
      .catch((e: Error) => current && setError(e.message.split("\n")[0]));
    return () => {
      current = false;
    };
  }, [account, venues, owner, accountAddress, version]);

  const result = useMemo(
    () => (positions && reserve ? runStress(positions, reserve.assets, scenario, thresholds) : undefined),
    [positions, reserve, scenario, thresholds],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Stress test</h2>
        <span className="eyebrow">What if bitcoin falls</span>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Scenario">
          {PRESETS.map((p) => {
            const on = p.scenario.btcDrop === scenario.btcDrop && p.scenario.ethDrop === scenario.ethDrop;
            return (
              <button
                key={p.label}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setScenario(p.scenario)}
                className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${on ? "border-chalk bg-chalk font-medium text-background" : "border-line-strong text-muted hover:text-foreground"}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <DropSlider label="Bitcoin" value={scenario.btcDrop} onChange={(btcDrop) => setScenario((s) => ({ ...s, btcDrop }))} />
        <DropSlider label="Ether" value={scenario.ethDrop} onChange={(ethDrop) => setScenario((s) => ({ ...s, ethDrop }))} />
      </div>

      {error && <p className="text-sm text-danger">Could not read the position: {error}</p>}
      {!result && !error && <p className="text-sm text-muted">Reading the position and the reserve…</p>}
      {result && positions && positions.length === 0 && (
        <p className="text-sm text-muted">No debt yet: there is nothing a price drop could liquidate.</p>
      )}
      {result && positions && positions.length > 0 && (
        <>
          <Verdict result={result} scenario={scenario} thresholds={thresholds} />
          <HealthChart curve={result.curve} thresholds={thresholds} />
          <ReserveTable result={result} />
        </>
      )}
      {reserve && reserve.errors.length > 0 && (
        <p className="text-xs text-faint">Left out, could not be read: {reserve.errors.join("; ")}.</p>
      )}
      <p className="text-xs text-faint">
        A simulation computed in your browser, from your position and reserve on chain; nothing
        is sent. Liquidation
        penalties use Aave V4&apos;s cirBTC parameters on Arc and Morpho&apos;s incentive for an 86% LLTV market.
      </p>
    </div>
  );
}

function DropSlider({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="grid grid-cols-[4rem_1fr_3.5rem] items-center gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <input
        type="range"
        min={0}
        max={90}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="accent-[var(--color-accent)]"
        aria-label={`${label} drop`}
      />
      <span className="text-right tabular-nums">−{Math.round(value * 100)}%</span>
    </label>
  );
}

function Verdict({ result, scenario, thresholds }: { result: StressResult; scenario: Scenario; thresholds: Thresholds }) {
  const drawnTotal = result.drawn.reduce((sum, x) => sum + x, 0);
  const without = result.curve.at(-1)!.without;
  return (
    <dl className="grid grid-cols-2 gap-2">
      <Stat
        label="Outcome"
        value={result.survives ? "Survives" : "Liquidated"}
        tone={result.survives ? "good" : "bad"}
        hint={
          result.survives
            ? `HF ${formatHf(result.finalHealthFactor)} after the keeper repays`
            : result.withOwner.survives
              ? "unless you move your other funds in time"
              : "the reserve runs out"
        }
      />
      <Stat label="Without Ardoise" value={`HF ${formatHf(without)}`} tone={without < 1 ? "bad" : undefined} hint={without < 1 ? "liquidated" : without < thresholds.minHealthFactor ? "under the guard minimum" : "no action needed"} />
      <Stat label="Reserve drawn" value={`$${formatUsd(drawnTotal)}`} hint={`at BTC −${Math.round(scenario.btcDrop * 100)}%`} />
      <Stat
        label="Penalty avoided"
        value={result.survives && result.liquidationLossUsd > 0 ? `$${formatUsd(result.liquidationLossUsd)}` : "$0"}
        hint={!result.survives ? "liquidated anyway" : result.liquidationLossUsd > 0 ? "liquidation bonus kept" : "no liquidation here"}
      />
    </dl>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-accent" : tone === "bad" ? "text-danger" : "";
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-line bg-sunken p-3">
      <dt className="eyebrow">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${color}`}>
        {tone === "good" && <span aria-hidden>✓ </span>}
        {tone === "bad" && <span aria-hidden>✕ </span>}
        {value}
      </dd>
      <dd className="text-xs text-faint">{hint}</dd>
    </div>
  );
}

// Validated against the card surface (#111111) with the dataviz palette checker.
const WITH_COLOR = "#c9730f";
const WITHOUT_COLOR = "#4a86cc";
const HF_TOP = 3;

/**
 * Health factor as bitcoin falls, with and without the reserve, against the
 * liquidation line and the guard minimum. One axis, two series, a legend
 * and a hover readout.
 */
function HealthChart({ curve, thresholds }: { curve: CurvePoint[]; thresholds: Thresholds }) {
  const [hover, setHover] = useState<number>();
  // Close to the rendered size in the half-width column, so text stays legible.
  const width = 360;
  const height = 180;
  const pad = { left: 24, right: 8, top: 14, bottom: 22 };
  const maxDrop = curve.at(-1)!.btcDrop || 1;
  const x = (drop: number) => pad.left + (drop / maxDrop) * (width - pad.left - pad.right);
  const y = (hf: number) => pad.top + (1 - Math.min(hf, HF_TOP) / HF_TOP) * (height - pad.top - pad.bottom);
  const path = (key: "without" | "withArdoise") =>
    curve.map((p, i) => `${i ? "L" : "M"}${x(p.btcDrop).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const point = hover === undefined ? undefined : curve[hover];

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">Lowest health factor as bitcoin falls (keeper only)</span>
        <span className="flex gap-3 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden><line x1="0" y1="2" x2="16" y2="2" stroke={WITH_COLOR} strokeWidth="2" /></svg>
            With Ardoise
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden><line x1="0" y1="2" x2="16" y2="2" stroke={WITHOUT_COLOR} strokeWidth="2" strokeDasharray="4 3" /></svg>
            Without
          </span>
        </span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          role="img"
          aria-label="Health factor with and without Ardoise as bitcoin falls"
          onMouseLeave={() => setHover(undefined)}
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const drop = (((e.clientX - box.left) / box.width) * width - pad.left) / (width - pad.left - pad.right) * maxDrop;
            const i = Math.round((Math.min(Math.max(drop, 0), maxDrop) / maxDrop) * (curve.length - 1));
            setHover(i);
          }}
        >
          {[0, 1, 2, 3].map((hf) => (
            <g key={hf}>
              <line x1={pad.left} x2={width - pad.right} y1={y(hf)} y2={y(hf)} stroke="var(--color-line)" strokeWidth="1" />
              <text x={pad.left - 6} y={y(hf) + 3} textAnchor="end" fontSize="10" fill="var(--color-faint)">
                {hf}
              </text>
            </g>
          ))}
          <line x1={pad.left} x2={width - pad.right} y1={y(1)} y2={y(1)} stroke="var(--color-danger)" strokeWidth="1" />
          <text x={pad.left + 4} y={y(1) - 4} fontSize="10" fill="var(--color-danger)">
            Liquidation
          </text>
          <line x1={pad.left} x2={width - pad.right} y1={y(thresholds.minHealthFactor)} y2={y(thresholds.minHealthFactor)} stroke="var(--color-line-strong)" strokeWidth="1" />
          <text x={pad.left + 4} y={y(thresholds.minHealthFactor) - 4} fontSize="10" fill="var(--color-faint)">
            Guard minimum {formatHf(thresholds.minHealthFactor)}
          </text>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <text
              key={t}
              x={x(maxDrop * t)}
              y={height - 6}
              textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"}
              fontSize="10"
              fill="var(--color-faint)"
            >
              −{Math.round(maxDrop * t * 100)}%
            </text>
          ))}
          <path d={path("without")} fill="none" stroke={WITHOUT_COLOR} strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
          <path d={path("withArdoise")} fill="none" stroke={WITH_COLOR} strokeWidth="2" strokeLinejoin="round" />
          {point && (
            <g>
              <line x1={x(point.btcDrop)} x2={x(point.btcDrop)} y1={pad.top} y2={height - pad.bottom} stroke="var(--color-line-strong)" strokeWidth="1" />
              <circle cx={x(point.btcDrop)} cy={y(point.without)} r="4" fill={WITHOUT_COLOR} stroke="var(--color-surface)" strokeWidth="2" />
              <circle cx={x(point.btcDrop)} cy={y(point.withArdoise)} r="4" fill={WITH_COLOR} stroke="var(--color-surface)" strokeWidth="2" />
            </g>
          )}
        </svg>
        {point && (
          <div className="pointer-events-none absolute top-1 left-10 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs shadow-lg">
            <div className="text-muted">BTC −{Math.round(point.btcDrop * 100)}%</div>
            <div className="tabular-nums">With Ardoise: HF {formatHf(point.withArdoise)}</div>
            <div className="tabular-nums">Without: HF {formatHf(point.without)}</div>
          </div>
        )}
      </div>
    </figure>
  );
}

function ReserveTable({ result }: { result: StressResult }) {
  if (result.reserve.length === 0) {
    return <p className="text-sm text-muted">No reserve found: the keeper has nothing to repay with when the margin falls.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">Reserve, asset by asset, in the order it is drawn</span>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-xs text-faint">
              <th className="py-1.5 pr-2 font-normal">#</th>
              <th className="py-1.5 pr-2 font-normal">Asset</th>
              <th className="py-1.5 pr-2 font-normal">Value</th>
              <th className="py-1.5 pr-2 font-normal">Haircut</th>
              <th className="py-1.5 pr-2 font-normal">Defense</th>
              <th className="py-1.5 pr-2 font-normal">Weight</th>
              <th className="py-1.5 font-normal">Drawn</th>
            </tr>
          </thead>
          <tbody>
            {result.reserve.map((line, i) => (
              <tr key={`${line.place}-${line.asset}-${line.chain}`} className="border-t border-line">
                <td className="py-2 pr-2 tabular-nums text-faint">{line.priority}</td>
                <td className="py-2 pr-2">
                  <div>
                    {line.asset} · {line.chain}
                  </div>
                  <div className="text-faint">
                    {line.place} · {SPEED_LABEL[line.speed]}
                  </div>
                </td>
                <td className="py-2 pr-2 tabular-nums">${formatUsd(line.valueUsd)}</td>
                <td className="py-2 pr-2 tabular-nums">{line.haircut > 0 ? `−${formatPercent(line.haircut)}` : "0%"}</td>
                <td className="py-2 pr-2 tabular-nums">${formatUsd(line.defenseUsd)}</td>
                <td className="py-2 pr-2 tabular-nums">{formatPercent(line.weight)}</td>
                <td className="py-2 tabular-nums">{result.drawn[i] > 0 ? `$${formatUsd(result.drawn[i])}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1 rounded-2xl border border-line bg-sunken px-4 py-3 text-sm">
        <p>
          On its own, the keeper covers a bitcoin drop {coverage(result.maxBtcDropCovered)}
          {result.withOwner.maxBtcDropCovered > result.maxBtcDropCovered && (
            <>; {coverage(result.withOwner.maxBtcDropCovered)} if you also move the rest of your reserve in time</>
          )}
          .
        </p>
        <p className="text-xs text-faint">
          The keeper draws only the account&apos;s USDC and the Gateway balance your standing orders cover; ether falls in
          the same proportion as this scenario.
        </p>
      </div>
    </div>
  );
}

function coverage(drop: number) {
  return drop >= 1 ? (
    <span className="font-semibold">of any size</span>
  ) : (
    <>
      down to <span className="font-semibold tabular-nums">−{Math.floor(drop * 100)}%</span>
    </>
  );
}

function wadToNumber(value: bigint): number {
  // No-debt health factors are type(uint256).max: Infinity, not a huge number.
  if (value > 10n ** 40n) return Infinity;
  return Number((value * 1_000_000n) / WAD) / 1_000_000;
}

function formatHf(hf: number): string {
  return Number.isFinite(hf) ? hf.toFixed(2) : "∞";
}

function formatUsd(usd: number): string {
  return usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
