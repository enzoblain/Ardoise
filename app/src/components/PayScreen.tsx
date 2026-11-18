"use client";

import { useEffect, useState } from "react";
import { isAddress, parseUnits, type Address, type Hex } from "viem";
import {
  PaymentFailed,
  PaymentUnconfirmed,
  marginFromHealth,
  type ArdoiseClient,
  type DebtLine,
  type PaymentError,
  type PaymentQuote,
  type Venue,
} from "@/lib/ardoise";
import { computeMaxFee, fetchFeeSchedule, type IrisFee } from "@/lib/fees";
import { formatBps, formatUsdc } from "@/lib/format";
import Link from "next/link";
import { chainByDomain, network, txUrl, type PayoutChain } from "@/lib/network";
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

  // `null`: no guard is set yet; undefined: not read yet.
  const [minHealthFactor, setMinHealthFactor] = useState<bigint | null>();
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
  // A payment sent whose outcome could not be read: never offer to pay again.
  const [unconfirmed, setUnconfirmed] = useState<{ hash: Hex; reason: string }>();
  const [readError, setReadError] = useState<string>();
  const [feeNotice, setFeeNotice] = useState<string>();

  const amount = parseAmount(amountText);
  const payeeValid = isAddress(payee);
  const schedule = schedules[destination.key];
  const maxFee = amount === undefined || schedule === undefined ? undefined : feeFor(schedule, amount);

  useEffect(() => {
    account
      .minHealthFactor()
      .then(setMinHealthFactor)
      .catch((e: Error) => setReadError(e.message.split("\n")[0]));
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
      .then((q) => {
        if (!current) return;
        setQuote(q);
        setReadError(undefined);
      })
      .catch((e: Error) => current && setReadError(e.message.split("\n")[0]));
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
    setFeeNotice(undefined);
    try {
      // Circle's forwarder fee moves. If it changed, show the new borrow and
      // its checks first: the user signs exactly what the screen displays.
      if (!account.simulated) {
        const latest = await fetchFeeSchedule(destination);
        const fee = feeFor(latest, amount);
        if (fee !== maxFee) {
          setSchedules((s) => ({ ...s, [destination.key]: latest }));
          setFeeNotice(`Circle's fee just changed to ${formatUsdc(fee)} USDC. Check the amounts and pay again.`);
          return;
        }
      }
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
      if (e instanceof PaymentUnconfirmed) setUnconfirmed({ hash: e.transactionHash, reason: e.message });
      else if (e instanceof PaymentFailed) setRefusal(e.reason);
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
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Pay</h2>
        <span className="eyebrow">Borrowed at payment time</span>
      </div>
      <fieldset className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="eyebrow">Amount</span>
          <div className="field flex items-center gap-2 py-2">
            <input
              inputMode="decimal"
              className="w-full bg-transparent text-4xl font-semibold tracking-tight tabular-nums outline-none"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={amountText !== "" && amount === undefined}
            />
            <span className="text-muted">USDC</span>
          </div>
        </label>

        <div className="flex flex-col gap-2">
          <span className="eyebrow">Payee&apos;s chain</span>
          <div className="grid grid-cols-2 gap-1 rounded-full border border-line-strong bg-sunken p-1" role="radiogroup" aria-label="Payee's chain">
            {DESTINATIONS.map((chain) => (
              <button
                key={chain.key}
                type="button"
                role="radio"
                aria-checked={destination.key === chain.key}
                onClick={() => setDestination(chain)}
                className={`rounded-full px-3 py-2 text-sm transition-colors ${destination.key === chain.key ? "bg-chalk font-medium text-background" : "text-muted hover:text-foreground"}`}
              >
                {chain.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-2">
          <span className="eyebrow">Payee address on {destination.label}</span>
          <input
            className="field font-mono text-sm"
            placeholder="0x…"
            value={payee}
            onChange={(e) => setPayee(e.target.value.trim())}
            aria-invalid={payee !== "" && !payeeValid}
          />
          {payee !== "" && !payeeValid && <span className="text-sm text-danger">Not a valid address.</span>}
        </label>

        <label className="flex flex-col gap-2">
          <span className="eyebrow">Memo · shown on the statement</span>
          <input
            className="field"
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
          minimum={minHealthFactor === null ? undefined : marginFromHealth(minHealthFactor)}
        />
      )}

      {amount !== undefined && (
        <dl className="grid grid-cols-[1fr_auto] gap-y-2 rounded-2xl border border-line bg-sunken p-4 text-sm">
          <dt className="text-muted">Payee receives at least</dt>
          <dd className="tabular-nums">{formatUsdc(amount)} USDC</dd>
          <dt className="text-muted">
            {destination.key === "arc" ? "Transfer fee (on Arc)" : `Max. CCTP fee to ${destination.label} (Circle)`}
          </dt>
          <dd className="tabular-nums">{maxFee === undefined ? "…" : `${formatUsdc(maxFee)} USDC`}</dd>
          <dt className="border-t border-line pt-2 font-medium">You borrow</dt>
          <dd className="border-t border-line pt-2 font-semibold tabular-nums">{maxFee === undefined ? "…" : `${formatUsdc(amount + maxFee)} USDC`}</dd>
        </dl>
      )}

      {feeError && <p className="text-sm text-danger">Could not get the fee from Circle: {feeError}</p>}
      {blocking && error && <p className="text-sm text-danger">{describeError(error)}</p>}
      {refusal && <p className="text-sm text-danger">{describeError(refusal)}</p>}
      {failure && <p className="text-sm text-danger">{failure}</p>}
      {feeNotice && <p className="text-sm text-accent">{feeNotice}</p>}
      {readError && <p className="text-sm text-danger">Could not read the account on chain: {readError}</p>}

      {unconfirmed && (
        <p className="rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm">
          The payment was sent but its confirmation could not be read ({unconfirmed.reason}). Check{" "}
          <a className="underline" href={txUrl(network.arc, unconfirmed.hash)} target="_blank" rel="noreferrer">
            the transaction
          </a>{" "}
          before paying again; the statement shows it once it is mined.
        </p>
      )}
      <button
        type="submit"
        disabled={!payeeValid || !fresh || !!error || sending || unconfirmed !== undefined}
        className="btn-primary py-3.5 text-base"
      >
        {sending ? "Paying…" : amount !== undefined ? `Pay ${formatUsdc(amount)} USDC` : "Pay"}
      </button>
    </form>
  );
}

function Receipt({ line, simulated, onNew }: { line: DebtLine; simulated: boolean; onNew: () => void }) {
  const chain = chainByDomain(line.destinationDomain);
  const crossChain = line.destinationDomain !== network.arc.cctpDomain;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_16px_rgba(247,147,26,0.7)]" aria-hidden />
        <h2 className="text-xl font-semibold tracking-tight">{simulated ? "Payment simulated" : "Payment sent"}</h2>
      </div>
      {simulated && (
        <p className="text-sm text-muted">Nothing was borrowed or sent on chain: this demo account is simulated.</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-2xl border border-line bg-sunken p-4 text-sm">
        <dt className="text-muted">To</dt>
        <dd className="break-all font-mono">0x{line.payee.slice(-40)}</dd>
        <dt className="text-muted">On</dt>
        <dd>{chain?.label ?? `CCTP domain ${line.destinationDomain}`}</dd>
        <dt className="text-muted">Borrowed</dt>
        <dd>
          {formatUsdc(line.principal)} USDC from {line.venue.name} at {formatBps(line.rateBps)}
        </dd>
        {line.memo && (
          <>
            <dt className="text-muted">Memo</dt>
            <dd>{line.memo}</dd>
          </>
        )}
        <dt className="text-muted">Debt line</dt>
        <dd>#{line.id.toString()}</dd>
        {line.transactionHash && (
          <>
            <dt className="text-muted">Transaction</dt>
            <dd>
              <a className="underline" href={txUrl(network.arc, line.transactionHash)} target="_blank" rel="noreferrer">
                {line.transactionHash.slice(0, 10)}… on {network.arc.label}
              </a>
            </dd>
          </>
        )}
      </dl>
      {line.transactionHash && crossChain && (
        <Link href={`/payments/${line.transactionHash}`} className="btn-primary">
          Track delivery on {chain?.label ?? "the payee's chain"}
        </Link>
      )}
      <button type="button" onClick={onNew} className="btn-secondary">
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
    case "GuardNotSet":
      return "Payments are not live yet: the position guard is not deployed on this network.";
    case "FeeOnArc":
      return "A payment on Arc carries no transfer fee.";
    case "ZeroAmount":
      return "Enter an amount above zero.";
    case "Reverted":
      return `The payment would fail on chain: ${error.message}`;
  }
}
