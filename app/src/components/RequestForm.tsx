"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { network, type PayoutChain } from "@/lib/network";
import { MAX_MEMO_LENGTH, buildRequestUrl, isRequestAmount, type RequestChain } from "@/lib/paymentRequest";

const CHAINS: PayoutChain[] = [network.base, network.arc];

/**
 * Builds a payment request: the payee enters where and how much they want to
 * be paid, and gets a link and a QR code that open Ardoise's pay screen with
 * the payment filled in. Nothing is stored: everything is in the link.
 */
export function RequestForm() {
  const [payee, setPayee] = useState("");
  const [chain, setChain] = useState<RequestChain>("base");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [origin, setOrigin] = useState<string>();
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);

  // The link must point at the site the payee is on (local, preview or production).
  useEffect(() => setOrigin(window.location.origin), []);

  const payeeValid = isAddress(payee);
  const amountValid = amount === "" || isRequestAmount(amount);
  const url =
    origin && payeeValid && amountValid
      ? buildRequestUrl(origin, { payee, chain, amount: amount || undefined, memo })
      : undefined;

  useEffect(() => {
    setCopied(false);
    if (!url) return setQr(undefined);
    let current = true;
    // Dark modules on chalk, the logo's colors, with the contrast scanners need.
    QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#0a0a0a", light: "#f5f5f0" } })
      .then((svg) => current && setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => current && setQr(undefined));
    return () => {
      current = false;
    };
  }, [url]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (permissions, insecure context): the link stays selectable.
      setCopied(false);
    }
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form className="card flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">Request a payment</h2>
          <p className="text-sm text-muted">
            Share a link or a QR code: the payer opens Ardoise with the payment ready and pays from their bitcoin.
          </p>
        </div>
        <label className="flex flex-col gap-2">
          <span className="eyebrow">Your address (receives the USDC)</span>
          <input
            className="field font-mono text-sm"
            placeholder="0x…"
            value={payee}
            onChange={(e) => setPayee(e.target.value.trim())}
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
                onClick={() => setChain(c.key as RequestChain)}
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
              onChange={(e) => setAmount(e.target.value.trim().replace(",", "."))}
              aria-invalid={!amountValid}
            />
            <span className="text-muted">USDC</span>
          </div>
          {!amountValid && <span className="text-sm text-danger">A positive amount, with at most 6 decimals.</span>}
        </label>
        <label className="flex flex-col gap-2">
          <span className="eyebrow">Memo · shown on the payer&apos;s statement</span>
          <input className="field" placeholder="Invoice #42" maxLength={MAX_MEMO_LENGTH} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </form>

      <section className="card flex flex-col items-center gap-5 text-center" aria-label="Request link">
        {url && qr ? (
          <>
            {/* A data URL built here, from our own link: no remote image to optimize. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qr}
              alt={`QR code: pay ${amount ? `${amount} USDC` : "any amount"} to ${payee} on ${CHAINS.find((c) => c.key === chain)?.label}`}
              width={240}
              height={240}
              className="rounded-2xl"
            />
            <div className="flex flex-col gap-1">
              <span className="text-2xl font-semibold tracking-tight">
                {amount ? `${amount} USDC` : "Any amount"}
              </span>
              <span className="text-sm text-muted">
                to <span className="font-mono">{`${payee.slice(0, 6)}…${payee.slice(-4)}`}</span> on{" "}
                {CHAINS.find((c) => c.key === chain)?.label}
                {memo.trim() && <> · {memo.trim()}</>}
              </span>
            </div>
            <input readOnly value={url} onFocus={(e) => e.target.select()} className="field w-full font-mono text-xs text-muted" aria-label="Request link" />
            <div className="flex flex-wrap justify-center gap-3">
              <button type="button" onClick={() => void copy()} className="btn-primary px-5 py-2.5 text-sm">
                <span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
              </button>
              <a href={qr} download="ardoise-payment-request.svg" className="btn-secondary px-5 py-2.5 text-sm">
                Download QR code
              </a>
              <a href={url} className="btn-secondary px-5 py-2.5 text-sm">
                Open as the payer
              </a>
            </div>
          </>
        ) : (
          <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-sm text-muted">
            <div className="h-40 w-40 rounded-2xl border border-dashed border-line-strong" aria-hidden />
            Enter your address to get the link and the QR code.
          </div>
        )}
      </section>
    </div>
  );
}
