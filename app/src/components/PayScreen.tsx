"use client";

import { useEffect, useMemo, useState } from "react";
import { isAddress, parseUnits, type Address } from "viem";
import {
  PaymentFailed,
  marginFromHealth,
  type Health,
  type PaymentError,
  type PaymentQuote,
  type Venue,
} from "@/lib/ardoise";
import { quoteMaxFee } from "@/lib/fees";
import { formatUsdc } from "@/lib/format";
import { createMockArdoise } from "@/lib/mockArdoise";
import { network, type PayoutChain } from "@/lib/network";
import { MarginGauge } from "@/components/MarginGauge";
import { RateComparison } from "@/components/RateComparison";

// Stands in for the payee until one is typed, so rates and margin can be
// previewed as soon as an amount is entered.
const PREVIEW_PAYEE: Address = "0x0000000000000000000000000000000000000001";
const DESTINATIONS: PayoutChain[] = [network.base, network.arc];

interface Receipt {
  lineId: bigint;
  amount: bigint;
  borrow: bigint;
  destination: PayoutChain;
  payee: Address;
  venue: Venue;
}

/**
 * Pay screen: amount, destination chain, payee and memo; shows the venue the
 * payment would borrow from, the margin before and after, and the CCTP fee,
 * then sends the payment through the account client.
 *
 * @param props.venues Venues with their live rates, read on the server.
 */
export function PayScreen({ venues }: { venues: Venue[] }) {
  // The mock keeps its state in memory for as long as the page is open.
  const account = useMemo(() => createMockArdoise(venues), [venues]);

  const [amountText, setAmountText] = useState("20");
  const [destination, setDestination] = useState<PayoutChain>(network.base);
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");

  const [health, setHealth] = useState<Health>();
  const [minHealthFactor, setMinHealthFactor] = useState<bigint>();
  const [maxFee, setMaxFee] = useState<bigint>();
  const [feeError, setFeeError] = useState<string>();
  const [quote, setQuote] = useState<PaymentQuote>();
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>();
  const [refusal, setRefusal] = useState<PaymentError>();

  const amount = parseAmount(amountText);
  const payeeValid = isAddress(payee);

  useEffect(() => {
    account.health().then(setHealth);
    account.minHealthFactor().then(setMinHealthFactor);
  }, [account]);

  // The CCTP fee depends on the route and, for some routes, on the amount.
  useEffect(() => {
    if (amount === undefined) return;
    let current = true;
    setMaxFee(undefined);
    setFeeError(undefined);
    const timer = setTimeout(() => {
      quoteMaxFee(destination, amount)
        .then((fee) => current && setMaxFee(fee))
        .catch((e: Error) => current && setFeeError(e.message));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [amount, destination]);

  useEffect(() => {
    if (amount === undefined || maxFee === undefined) {
      setQuote(undefined);
      return;
    }
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
    // `health` is listed so the quote refreshes after a payment.
  }, [account, amount, maxFee, destination, payee, payeeValid, memo, health]);

  async function send() {
    if (amount === undefined || maxFee === undefined || !payeeValid) return;
    setSending(true);
    setRefusal(undefined);
    try {
      const lineId = await account.pay({
        amount,
        destinationDomain: destination.cctpDomain,
        payee: payee as Address,
        maxFee,
        memo,
      });
      setReceipt({ lineId, amount, borrow: quote!.borrow, destination, payee: payee as Address, venue: quote!.venue! });
      setHealth(await account.health());
    } catch (e) {
      if (e instanceof PaymentFailed) setRefusal(e.reason);
      else throw e;
    } finally {
      setSending(false);
    }
  }

  const error = quote?.error;
  const blocking = error && !(error.code === "InvalidPayee" && !payeeValid);

  if (receipt) {
    return (
      <Receipt
        receipt={receipt}
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
        send();
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

      <RateComparison venues={venues} chosenId={quote?.venue?.id} />

      {health && minHealthFactor !== undefined && (
        <MarginGauge
          before={marginFromHealth(health.healthFactor)}
          after={quote?.healthAfter !== undefined ? marginFromHealth(quote.healthAfter) : undefined}
          minimum={marginFromHealth(minHealthFactor)}
        />
      )}

      {amount !== undefined && (
        <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <dt className="opacity-70">Payee receives at least</dt>
          <dd className="tabular-nums">{formatUsdc(amount)} USDC</dd>
          <dt className="opacity-70">
            {destination.key === "arc" ? "Transfer fee (on Arc)" : "Max. CCTP fee to Base (Circle)"}
          </dt>
          <dd className="tabular-nums">{maxFee === undefined ? "…" : `${formatUsdc(maxFee)} USDC`}</dd>
          <dt className="font-medium">You borrow</dt>
          <dd className="font-medium tabular-nums">{quote ? `${formatUsdc(quote.borrow)} USDC` : "…"}</dd>
        </dl>
      )}

      {feeError && <p className="text-sm text-red-600">Could not get the fee from Circle: {feeError}</p>}
      {blocking && error && <p className="text-sm text-red-600">{describeError(error)}</p>}
      {refusal && <p className="text-sm text-red-600">{describeError(refusal)}</p>}

      <button
        type="submit"
        disabled={!payeeValid || !quote || !!error || sending}
        className="rounded-lg bg-foreground px-4 py-3 font-semibold text-background disabled:opacity-40"
      >
        {sending ? "Paying…" : amount !== undefined ? `Pay ${formatUsdc(amount)} USDC` : "Pay"}
      </button>
    </form>
  );
}

function Receipt({ receipt, simulated, onNew }: { receipt: Receipt; simulated: boolean; onNew: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">{simulated ? "Payment simulated" : "Payment sent"}</h2>
      {simulated && (
        <p className="text-sm opacity-70">Nothing was borrowed or sent on chain: this demo account is simulated.</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-70">Amount</dt>
        <dd>{formatUsdc(receipt.amount)} USDC</dd>
        <dt className="opacity-70">To</dt>
        <dd className="break-all font-mono">{receipt.payee}</dd>
        <dt className="opacity-70">On</dt>
        <dd>{receipt.destination.label}</dd>
        <dt className="opacity-70">Borrowed</dt>
        <dd>
          {formatUsdc(receipt.borrow)} USDC from {receipt.venue.name}
        </dd>
        <dt className="opacity-70">Debt line</dt>
        <dd>#{receipt.lineId.toString()}</dd>
      </dl>
      <button type="button" onClick={onNew} className="rounded-lg border border-current px-4 py-2 font-medium">
        New payment
      </button>
    </div>
  );
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
