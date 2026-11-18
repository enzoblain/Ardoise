"use client";

import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { isAddress, parseUnits, zeroAddress } from "viem";
import { formatUsdc } from "@/lib/format";
import { network, txUrl, type PayoutChain } from "@/lib/network";
import {
  MAX_MEMO_LENGTH,
  buildRequestUrl,
  cleanMemo,
  isRequestAmount,
  newRequestId,
  type PaymentRequest,
} from "@/lib/paymentRequest";
import { deadlineOf, landedInTime, publish } from "@/lib/requestSession";
import { RequestWatcher, currentBlock, type ReceivedPayment } from "@/lib/requestWatch";
import { useNow, useReached, useRequestSession } from "@/components/useRequestSession";

const CHAINS: PayoutChain[] = [network.base, network.arc];
/** How often the waiting page reads the payee's chain. */
const POLL_MS = 4_000;
/** Longest wait between reads after errors (rate limits back off up to this). */
const MAX_POLL_MS = 30_000;

/** A request the payee confirmed, and the block it is watched from. */
interface OpenRequest {
  request: PaymentRequest & { id: string };
  url: string;
  chain: PayoutChain;
  fromBlock: bigint;
}

/**
 * Payment requests, in two steps. The payee fills in where and how much they
 * want to be paid and creates the request; the page then shows its link and
 * QR code and waits. Through the live session it shows when the payer opens
 * the link, counts down the payer's 30 s and lets the payee cancel; on chain
 * it watches for the USDC, and flags a payment that lands after the request
 * closed. Nothing is stored: the request lives in the link and in this page.
 */
export function RequestForm() {
  const [open, setOpen] = useState<OpenRequest>();
  // The request being edited: editing keeps its id and start block, so the
  // link already shared and a payment made meanwhile still count.
  const [editing, setEditing] = useState<OpenRequest>();
  const [draft, setDraft] = useState({ payee: "", chain: "base" as PaymentRequest["chain"], amount: "", memo: "" });
  return open ? (
    <WaitingView
      open={open}
      onEdit={() => {
        setEditing(open);
        setOpen(undefined);
      }}
      onNew={() => {
        setDraft({ payee: draft.payee, chain: draft.chain, amount: "", memo: "" });
        setEditing(undefined);
        setOpen(undefined);
      }}
    />
  ) : (
    <DraftForm draft={draft} editing={editing} onChange={setDraft} onCreate={setOpen} />
  );
}

function DraftForm({
  draft,
  editing,
  onChange,
  onCreate,
}: {
  draft: { payee: string; chain: PaymentRequest["chain"]; amount: string; memo: string };
  editing?: OpenRequest;
  onChange: (draft: { payee: string; chain: PaymentRequest["chain"]; amount: string; memo: string }) => void;
  onCreate: (open: OpenRequest) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const { payee, chain, amount, memo } = draft;
  const payeeValid = isAddress(payee);
  const amountValid = amount === "" || isRequestAmount(amount);
  const set = (patch: Partial<typeof draft>) => onChange({ ...draft, ...patch });

  async function create() {
    if (!payeeValid || !amountValid) return;
    setCreating(true);
    setError(undefined);
    const target = CHAINS.find((c) => c.key === chain) ?? network.base;
    try {
      // Only transfers from now on count: an older payment of the same amount
      // to the same address must not confirm this request. An edit of the same
      // address and chain keeps watching from where the request started.
      const same = editing && editing.chain.key === chain && editing.request.payee.toLowerCase() === payee.toLowerCase();
      const fromBlock = same ? editing.fromBlock : await currentBlock(target);
      const id = same ? editing.request.id : newRequestId();
      const request = { payee, chain, amount: amount || undefined, memo: cleanMemo(memo) || undefined, id };
      onCreate({ request, url: buildRequestUrl(window.location.origin, request), chain: target, fromBlock });
    } catch (e) {
      setError(`Could not reach ${target.label}: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <form
      className="card mx-auto flex w-full max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Request a payment</h2>
        <p className="text-sm text-muted">
          Create the request, share its link or QR code, and this page tells you when the USDC has arrived. The payer
          pays from their bitcoin with Ardoise.
        </p>
      </div>
      <label className="flex flex-col gap-2">
        <span className="eyebrow">Your address (receives the USDC)</span>
        <input
          className="field font-mono text-sm"
          placeholder="0x…"
          value={payee}
          onChange={(e) => set({ payee: e.target.value.trim() })}
          aria-invalid={payee !== "" && !payeeValid}
        />
        {payee !== "" && !payeeValid && <span className="text-sm text-danger">Not a valid address.</span>}
      </label>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Paid on</span>
        <div className="grid grid-cols-2 gap-1 rounded-full border border-line-strong bg-sunken p-1" role="radiogroup" aria-label="Chain to be paid on">
          {CHAINS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={chain === c.key}
              onClick={() => set({ chain: c.key })}
              className={`rounded-full px-3 py-2 text-sm transition-colors ${chain === c.key ? "bg-chalk font-medium text-background" : "text-muted hover:text-foreground"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-2">
        <span className="eyebrow">Amount · optional</span>
        <div className="field flex items-center gap-2">
          <input
            inputMode="decimal"
            className="w-full bg-transparent tabular-nums outline-none"
            placeholder="Let the payer choose"
            value={amount}
            onChange={(e) => set({ amount: e.target.value.trim().replace(",", ".") })}
            aria-invalid={!amountValid}
          />
          <span className="text-muted">USDC</span>
        </div>
        {!amountValid && <span className="text-sm text-danger">A positive amount, with at most 6 decimals.</span>}
      </label>
      <label className="flex flex-col gap-2">
        <span className="eyebrow">Memo · shown on the payer&apos;s statement</span>
        <input className="field" placeholder="Invoice #42" maxLength={MAX_MEMO_LENGTH} value={memo} onChange={(e) => set({ memo: e.target.value })} />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button type="submit" disabled={!payeeValid || !amountValid || creating} className="btn-primary py-3.5 text-base">
        {creating ? "Creating…" : editing ? "Update request" : "Create request"}
      </button>
    </form>
  );
}

function WaitingView({ open, onEdit, onNew }: { open: OpenRequest; onEdit: () => void; onNew: () => void }) {
  const { request, url, chain } = open;
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [onChain, setOnChain] = useState<ReceivedPayment>();
  const [checkError, setCheckError] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const minAmount = request.amount ? parseUnits(request.amount, 6) : 0n;
  const amountLabel = request.amount ? `${request.amount} USDC` : "Any amount";

  const [cancelling, setCancelling] = useState<"sending" | "failed">();

  const { state, relay, offset } = useRequestSession(request.id, false);
  const deadline = deadlineOf(state);
  const deadlinePassed = useReached(deadline, offset);
  const now = useNow(250, deadline !== undefined && !deadlinePassed && state.closedAt === undefined && !onChain, offset);

  // Only a payment seen on chain is money received. A "simulated" report comes
  // from the relay, which anyone holding the link can write to, so it gets a
  // neutral view of its own and never the received one.
  const demoReported = !onChain && state.paid?.simulated === true && state.closedAt === undefined;
  const paidAt = onChain ? (onChain.landedAt ?? Date.now() + offset) : undefined;
  const late = paidAt !== undefined && !landedInTime(state, paidAt);
  const expired = state.closedBy === "expired" || (deadlinePassed && !onChain && !demoReported);
  const cancelled = state.closedBy === "cancelled";
  const view: "received" | "late" | "demo" | "closed" | "joined" | "waiting" =
    paidAt !== undefined
      ? late
        ? "late"
        : "received"
      : demoReported
        ? "demo"
        : cancelled || expired
          ? "closed"
          : deadline !== undefined
            ? "joined"
            : "waiting";
  const previewUrl = buildRequestUrl(new URL(url).origin, { ...request, preview: true });

  // Each view replaces the last: move focus to its heading so keyboard and screen reader users follow.
  useEffect(() => heading.current?.focus(), [view]);

  useEffect(() => {
    let current = true;
    // Dark modules on chalk, the logo's colors, with the contrast scanners need.
    QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#0a0a0a", light: "#f5f5f0" } })
      .then((svg) => current && setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => current && setQr(undefined));
    return () => {
      current = false;
    };
  }, [url]);

  // The real check: USDC reaching the payee on their chain. It keeps running
  // after the request closes, so a late payment is still shown, to be refunded.
  useEffect(() => {
    if (onChain) return;
    const watcher = new RequestWatcher(chain, request.payee, minAmount, open.fromBlock);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = POLL_MS;
    const poll = async () => {
      try {
        const payment = await watcher.check();
        if (stopped) return;
        setCheckError(false);
        delay = POLL_MS;
        if (payment) return setOnChain(payment);
      } catch {
        // Public RPCs throttle: back off, and resume from the same block.
        if (stopped) return;
        setCheckError(true);
        delay = Math.min(delay * 2, MAX_POLL_MS);
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [chain, request.payee, minAmount, open.fromBlock, onChain]);

  // Tell the payer's screen: a real payment that came in time, or the end of the 30 s.
  useEffect(() => {
    if (view === "received" && onChain && !state.paid) publish(request.id, { type: "paid", simulated: false }).catch(() => {});
    if (view === "closed" && expired && state.closedAt === undefined) publish(request.id, { type: "expired" }).catch(() => {});
  }, [view, onChain, expired, state.paid, state.closedAt, request.id]);

  async function cancel() {
    setCancelling("sending");
    try {
      await publish(request.id, { type: "cancelled" });
      setCancelling(undefined);
    } catch {
      setCancelling("failed");
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (permissions, insecure context): the link stays selectable.
      setCopied(false);
    }
  }

  const amountPaid = onChain ? `${formatUsdc(onChain.amount)} USDC` : amountLabel;
  // Rendered in every view so screen readers announce the change.
  const announcement = (
    <p className="sr-only" aria-live="polite">
      {view === "joined"
        ? "The payer opened the request."
        : view === "demo"
          ? "A demo payment was reported: no USDC was received."
          : view === "received"
          ? `Payment received: ${amountPaid}.`
          : view === "late"
            ? "A payment arrived after the request closed."
            : view === "closed"
              ? cancelled
                ? "Request cancelled."
                : "Request expired."
              : ""}
    </p>
  );
  const proof = onChain ? (
    <p className="text-sm text-muted">
      {/* A CCTP payment is minted to the payee, so it comes from the zero address. */}
      {onChain.from === zeroAddress ? (
        "Delivered by Circle (CCTP)"
      ) : (
        <>
          From <span className="font-mono">{onChain.from}</span>
        </>
      )}{" "}
      ·{" "}
      <a className="underline underline-offset-4" href={txUrl(chain, onChain.transactionHash)} target="_blank" rel="noreferrer">
        transaction ↗
      </a>
    </p>
  ) : null;

  if (view === "demo") {
    return (
      <>
        {announcement}
        <section className="card mx-auto flex w-full max-w-xl flex-col items-center gap-5 py-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-line-strong text-2xl text-muted" aria-hidden>
            i
          </span>
          <div className="flex flex-col gap-1">
            <h2 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
              Demo payment reported
            </h2>
            <span className="text-sm text-muted">
              {amountLabel} · {chain.label}
              {request.memo && <> · {request.memo}</>}
            </span>
          </div>
          <p className="max-w-sm text-sm text-muted">
            The payer used Ardoise&apos;s demo account, which simulates payments: <strong className="text-foreground">no USDC was received</strong>. A real payment shows here once it is seen on {chain.label}.
          </p>
          <button type="button" onClick={onNew} className="btn-primary px-6">
            New request
          </button>
        </section>
      </>
    );
  }

  if (view === "received" || view === "late" || view === "closed") {
    const badge =
      view === "received"
        ? "bg-chalk text-background shadow-[0_0_40px_rgba(245,245,240,0.25)]"
        : view === "late"
          ? "bg-accent text-background"
          : "border border-line-strong text-muted";
    const title =
      view === "received"
        ? "Payment received"
        : view === "late"
          ? "Paid after the request closed"
          : cancelled
            ? "Request cancelled"
            : "Request expired";
    return (
      <>
        {announcement}
        <section className="card mx-auto flex w-full max-w-xl flex-col items-center gap-5 py-10 text-center">
          <span className={`flex h-16 w-16 items-center justify-center rounded-full text-3xl ${badge}`} aria-hidden>
            {view === "received" ? "✓" : view === "late" ? "!" : "✕"}
          </span>
          <div className="flex flex-col gap-1">
            <h2 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
              {title}
            </h2>
            {view !== "closed" && <span className="text-4xl font-semibold tracking-tight tabular-nums">{amountPaid}</span>}
            <span className="text-sm text-muted">
              {view === "closed" ? `${amountLabel} · ` : "on "}
              {chain.label}
              {request.memo && <> · {request.memo}</>}
            </span>
          </div>
          {view === "closed" && (
            <p className="max-w-sm text-sm text-muted">
              {cancelled
                ? "The payer can no longer pay this request."
                : "The payer did not pay within 30 seconds of opening the request; they can no longer pay it."}{" "}
              This page keeps watching {chain.label} in case a payment was already on its way.
            </p>
          )}
          {view === "late" && (
            <p className="max-w-sm text-sm text-accent">
              The payment landed more than a minute after the request closed. A payment on chain cannot be refused:
              refund the payer if you do not accept it.
            </p>
          )}
          {view !== "closed" && proof}
          <button type="button" onClick={onNew} className="btn-primary px-6">
            New request
          </button>
        </section>
      </>
    );
  }

  const secondsLeft = deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <>
      {announcement}
      <section className="card mx-auto flex w-full max-w-xl flex-col items-center gap-5 text-center" aria-labelledby="waiting-title">
        <h2 id="waiting-title" ref={heading} tabIndex={-1} className="sr-only">
          {view === "joined" ? "The payer opened the request" : "Waiting for the payer"}
        </h2>
        {qr ? (
          // A data URL built here, from our own link: no remote image to optimize.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt={`QR code: pay ${amountLabel.toLowerCase()} to ${request.payee} on ${chain.label}`}
            width={view === "joined" ? 160 : 240}
            height={view === "joined" ? 160 : 240}
            className="rounded-2xl transition-[width,height]"
          />
        ) : (
          <div className="h-60 w-60 rounded-2xl border border-dashed border-line-strong" aria-hidden />
        )}
        <div className="flex flex-col gap-1">
          <span className="text-3xl font-semibold tracking-tight">{amountLabel}</span>
          <span className="text-sm text-muted">
            to <span className="break-all font-mono">{request.payee}</span> on {chain.label}
            {request.memo && <> · {request.memo}</>}
          </span>
        </div>
        {view === "joined" && secondsLeft !== undefined ? (
          <div className="flex w-full flex-col items-center gap-2">
            <p className="flex items-center gap-2.5 text-sm font-medium">
              <span className="h-2 w-2 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />
              Payer connected: waiting for their payment
            </p>
            <span className="text-5xl font-semibold tabular-nums tracking-tight" role="timer" aria-label={`${secondsLeft} seconds left`}>
              {secondsLeft} s
            </span>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-line-strong"
              role="progressbar"
              aria-label="Time left for the payer"
              aria-valuemin={0}
              aria-valuemax={30}
              aria-valuenow={secondsLeft}
            >
              <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${(secondsLeft / 30) * 100}%` }} />
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2.5 text-sm">
            <span className="h-2 w-2 rounded-full bg-chalk motion-safe:animate-pulse" aria-hidden />
            Waiting for the payer to open the link…
          </p>
        )}
        <p className="text-xs text-faint">
          {relay === "down"
            ? "The live session is unavailable: the payer's connection and the 30 s limit cannot be shown. The payment itself is still confirmed on chain."
            : checkError
              ? `${chain.label} did not answer; checking again.`
              : view === "joined"
                ? "The payer has 30 seconds from opening the link to pay."
                : `Once the payer opens the link, they have 30 seconds to pay. Keep this page open.`}
        </p>
        {view === "waiting" && (
          <input readOnly value={url} onFocus={(e) => e.target.select()} className="field w-full font-mono text-xs text-muted" aria-label="Request link" />
        )}
        <div className="flex flex-wrap justify-center gap-3">
          {view === "waiting" && (
            <>
              <button type="button" onClick={() => void copy()} className="btn-primary px-5 py-2.5 text-sm">
                <span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
              </button>
              {qr && (
                <a href={qr} download="ardoise-payment-request.svg" className="btn-secondary px-5 py-2.5 text-sm">
                  Download QR code
                </a>
              )}
              {/* A preview: opening it does not start the real payer's 30 s. */}
              <a href={previewUrl} target="_blank" rel="noreferrer" className="btn-secondary px-5 py-2.5 text-sm">
                Open as the payer ↗
              </a>
              <button type="button" onClick={onEdit} className="btn-secondary px-5 py-2.5 text-sm">
                Edit request
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={relay !== "live" || cancelling === "sending"}
            className="btn-secondary px-5 py-2.5 text-sm text-danger"
          >
            {cancelling === "sending" ? "Cancelling…" : "Cancel request"}
          </button>
        </div>
        {cancelling === "failed" && (
          <p role="alert" className="text-sm text-danger">
            The request could not be cancelled: the relay did not answer. Try again.
          </p>
        )}
      </section>
    </>
  );
}
