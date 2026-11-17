"use client";

import { useEffect, useState } from "react";
import { isAddress, parseUnits, type Address } from "viem";
import {
  PaymentFailed,
  marginFromHealth,
  type ArdoiseClient,
  type DebtLine,
  type PaymentError,
  type PaymentQuote,
  type Venue,
} from "@/lib/ardoise";
import { computeMaxFee, fetchFeeSchedule, type IrisFee } from "@/lib/fees";
import { formatBps, formatUsdc } from "@/lib/format";
import { chainByDomain, network, type PayoutChain } from "@/lib/network";
import { MarginGauge } from "@/components/MarginGauge";
import { RateComparison } from "@/components/RateComparison";

// Stands in for the payee until one is typed, so rates and margin can be
// previewed as soon as an amount is entered.
const PREVIEW_PAYEE: Address = "0x0000000000000000000000000000000000000001";
const DESTINATIONS: PayoutChain[] = [network.base, network.arc];

/**
 * Pay screen: amount, destination chain, payee and memo; shows the venue the
 * payment would borrow from, the margin on that venue before and after, and
 * the CCTP fee, then sends the payment through the account client.
 *
 * @param props.account Account client the payment goes through.
 * @param props.venues Venues with their live rates, read on the server.
 * @param props.onPaid Called after each successful payment.
 */
export function PayScreen({
  account,
  venues,
  onPaid,
}: {
  account: ArdoiseClient;
  venues: Venue[];
  onPaid: () => void;
}) {
  const [amountText, setAmountText] = useState("20");
  const [destination, setDestination] = useState<PayoutChain>(network.base);
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");

  const [minHealthFactor, setMinHealthFactor] = useState<bigint>();
  // Circle's fee schedule per route: `null` for Arc (no fee), absent while loading.
  const [schedules, setSchedules] = useState<Record<string, IrisFee[] | null>>({});
  const [feeError, setFeeError] = useState<string>();
  const [quote, setQuote] = useState<PaymentQuote>();
  const [sending, setSending] = useState(false);
  // Bumped after each payment so the quote is recomputed on the new position.
  const [paymentCount, setPaymentCount] = useState(0);
  const [receipt, setReceipt] = useState<DebtLine>();
  const [refusal, setRefusal] = useState<PaymentError>();
  const [failure, setFailure] = useState<string>();

  const amount = parseAmount(amountText);
  const payeeValid = isAddress(payee);
  const schedule = schedules[destination.key];
  const maxFee = amount === undefined || schedule === undefined ? undefined : feeFor(schedule, amount);

  useEffect(() => {
    account.minHealthFactor().then(setMinHealthFactor);
  }, [account]);

  // The schedule only depends on the route, so it is fetched once per chain.
  useEffect(() => {
    setFeeError(undefined);
    if (destination.key in schedules) return;
    let current = true;
    fetchFeeSchedule(destination)
      .then((fees) => {
        // Reject a schedule without a fast transfer here, where the error can
        // be shown, rather than when the fee is computed during render.
        if (fees) computeMaxFee(fees, 0n);
        if (current) setSchedules((s) => ({ ...s, [destination.key]: fees }));
      })
      .catch((e: Error) => current && setFeeError(e.message));
    return () => {
      current = false;
    };
  }, [destination, schedules]);

  useEffect(() => {
    setQuote(undefined);
    if (amount === undefined || maxFee === undefined) return;
    let current = true;
    account
      .quote({
        amount,
        destinationDomain: destination.cctpDomain,
        payee: payeeValid ? (payee as Address) : PREVIEW_PAYEE,
        maxFee,
        memo,
      })
      .then((q) => current && setQuote(q));
    return () => {
      current = false;
    };
  }, [account, amount, maxFee, destination, payee, payeeValid, memo, paymentCount]);

  // A quote is only used if it was computed for what the form shows now.
  const fresh = quote !== undefined && amount !== undefined && maxFee !== undefined && quote.borrow === amount + maxFee;

  async function send() {
    if (amount === undefined || maxFee === undefined || !payeeValid || !fresh) return;
    setSending(true);
    setRefusal(undefined);
    setFailure(undefined);
    try {
      const line = await account.pay({
        amount,
        destinationDomain: destination.cctpDomain,
        payee: payee as Address,
        maxFee,
        memo,
      });
      setReceipt(line);
      setPaymentCount((n) => n + 1);
      onPaid();
    } catch (e) {
      if (e instanceof PaymentFailed) setRefusal(e.reason);
      else setFailure((e as Error).message || "The payment could not be sent.");
    } finally {
      setSending(false);
    }
  }

  const error = fresh ? quote.error : undefined;
  const blocking = error && !(error.code === "InvalidPayee" && !payeeValid);

  if (receipt) {
    return (
      <Receipt
        line={receipt}
        simulated={account.simulated}
        onNew={() => {
          setReceipt(undefined);
          setPayee("");
          setMemo("");
        }}
      />
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <fieldset className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm opacity-70">Amount</span>
          <div className="flex items-center gap-2 rounded-lg border border-black/15 px-3 dark:border-white/20">
            <input
              inputMode="decimal"
              className="w-full bg-transparent py-2 text-2xl font-semibold tabular-nums outline-none"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={amountText !== "" && amount === undefined}
            />
            <span className="opacity-60">USDC</span>
          </div>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-sm opacity-70">Payee&apos;s chain</span>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payee's chain">
            {DESTINATIONS.map((chain) => (
              <button
                key={chain.key}
                type="button"
                role="radio"
                aria-checked={destination.key === chain.key}
                onClick={() => setDestination(chain)}
                className={`rounded-lg border px-3 py-2 text-left ${destination.key === chain.key ? "border-current font-medium" : "border-black/10 opacity-70 dark:border-white/15"}`}
              >
                {chain.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-sm opacity-70">Payee address on {destination.label}</span>
          <input
            className="rounded-lg border border-black/15 px-3 py-2 font-mono text-sm outline-none dark:border-white/20"
            placeholder="0x…"
            value={payee}
            onChange={(e) => setPayee(e.target.value.trim())}
            aria-invalid={payee !== "" && !payeeValid}
          />
          {payee !== "" && !payeeValid && <span className="text-sm text-red-600">Not a valid address.</span>}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm opacity-70">Memo (shown on the statement)</span>
          <input
            className="rounded-lg border border-black/15 px-3 py-2 outline-none dark:border-white/20"
            placeholder="Invoice #42"
            maxLength={120}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </label>
      </fieldset>

      <RateComparison venues={venues} chosenId={fresh ? quote.venue?.id : undefined} />

      {fresh && quote.venue && quote.healthBefore && minHealthFactor !== undefined && (
        <MarginGauge
          venueName={quote.venue.name}
          before={marginFromHealth(quote.healthBefore.healthFactor)}
          after={quote.healthAfter !== undefined ? marginFromHealth(quote.healthAfter) : undefined}
          minimum={marginFromHealth(minHealthFactor)}
        />
      )}

      {amount !== undefined && (
        <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <dt className="opacity-70">Payee receives at least</dt>
          <dd className="tabular-nums">{formatUsdc(amount)} USDC</dd>
          <dt className="opacity-70">
            {destination.key === "arc" ? "Transfer fee (on Arc)" : `Max. CCTP fee to ${destination.label} (Circle)`}
          </dt>
          <dd className="tabular-nums">{maxFee === undefined ? "…" : `${formatUsdc(maxFee)} USDC`}</dd>
          <dt className="font-medium">You borrow</dt>
          <dd className="font-medium tabular-nums">{maxFee === undefined ? "…" : `${formatUsdc(amount + maxFee)} USDC`}</dd>
        </dl>
      )}

      {feeError && <p className="text-sm text-red-600">Could not get the fee from Circle: {feeError}</p>}
      {blocking && error && <p className="text-sm text-red-600">{describeError(error)}</p>}
      {refusal && <p className="text-sm text-red-600">{describeError(refusal)}</p>}
      {failure && <p className="text-sm text-red-600">{failure}</p>}

      <button
        type="submit"
        disabled={!payeeValid || !fresh || !!error || sending}
        className="rounded-lg bg-foreground px-4 py-3 font-semibold text-background disabled:opacity-40"
      >
        {sending ? "Paying…" : amount !== undefined ? `Pay ${formatUsdc(amount)} USDC` : "Pay"}
      </button>
    </form>
  );
}

function Receipt({ line, simulated, onNew }: { line: DebtLine; simulated: boolean; onNew: () => void }) {
  const chain = chainByDomain(line.destinationDomain);
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">{simulated ? "Payment simulated" : "Payment sent"}</h2>
      {simulated && (
        <p className="text-sm opacity-70">Nothing was borrowed or sent on chain: this demo account is simulated.</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-70">To</dt>
        <dd className="break-all font-mono">0x{line.payee.slice(-40)}</dd>
        <dt className="opacity-70">On</dt>
        <dd>{chain?.label ?? `CCTP domain ${line.destinationDomain}`}</dd>
        <dt className="opacity-70">Borrowed</dt>
        <dd>
          {formatUsdc(line.principal)} USDC from {line.venue.name} at {formatBps(line.rateBps)}
        </dd>
        {line.memo && (
          <>
            <dt className="opacity-70">Memo</dt>
            <dd>{line.memo}</dd>
          </>
        )}
        <dt className="opacity-70">Debt line</dt>
        <dd>#{line.id.toString()}</dd>
      </dl>
      <button type="button" onClick={onNew} className="rounded-lg border border-current px-4 py-2 font-medium">
        New payment
      </button>
    </div>
  );
}

// `null` is the Arc schedule: a plain transfer, no fee.
function feeFor(schedule: IrisFee[] | null, amount: bigint): bigint {
  return schedule === null ? 0n : computeMaxFee(schedule, amount);
}

function parseAmount(text: string): bigint | undefined {
  try {
    const value = parseUnits(text.replace(",", "."), 6);
    return value > 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

function describeError(error: PaymentError): string {
  switch (error.code) {
    case "InvalidPayee":
      return "Enter a valid payee address.";
    case "CapExceeded":
      return `Over your spending cap: ${formatUsdc(error.remaining)} USDC left (fees included).`;
    case "NoVenueAvailable":
      return "No lending venue has enough USDC for this amount right now.";
    case "PaymentRefused":
      return error.allowed > 0n
        ? `Refused to protect your position: it would leave too little margin. You can borrow up to ${formatUsdc(error.allowed)} USDC (fees included) right now.`
        : "Refused to protect your position: there is no margin left to borrow against.";
  }
}
