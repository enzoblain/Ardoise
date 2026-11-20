"use client";

import { useCallback, useEffect, useState } from "react";
import { parseUnits, type Address, type Hex } from "viem";
import { formatUsdc } from "@/lib/format";
import {
  KEEPER_URL,
  gatewayBalance,
  gatewayTransfer,
  keeperOrders,
  orderSpec,
  sendToKeeper,
  signOrder,
  submitToGateway,
  type OrderSummary,
  type StandingOrder,
} from "@/lib/gateway";
import type { GatewaySigner } from "@/lib/gatewaySigner";
import { network, txUrl } from "@/lib/network";

const POLL_MS = 3_000;

/**
 * Protection from the user's dollars on Base (B4): the Gateway reserve,
 * the standing orders the keeper may use when the margin gets too low, and
 * a one-click repayment from that reserve.
 *
 * @param props.signer The owner's wallet (browser or passkey): depositor and
 *   signer on Gateway, owner of the account.
 * @param props.account The owner's Ardoise account, the only recipient orders may name.
 */
export function ProtectionPanel({ signer, account }: { signer: GatewaySigner; account: Address }) {
  const owner = signer.address;
  const confirming = signer.prompt === "passkey" ? "Confirm with your passkey…" : "Confirm in your wallet…";
  const [balance, setBalance] = useState<bigint>();
  const [orders, setOrders] = useState<OrderSummary[]>();
  // Stops a running delivery poll when the panel goes away.
  const [mounted] = useState(() => ({ current: true }));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [mounted]);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ text: string; tx?: { chain: "arc" | "base"; hash: Hex } }>();
  const [error, setError] = useState<string>();
  const [depositText, setDepositText] = useState("5");
  const [orderValueText, setOrderValueText] = useState("5");
  const [orderCount, setOrderCount] = useState(2);
  const [repayText, setRepayText] = useState("1");
  const [delivered, setDelivered] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setBalance(await gatewayBalance(owner));
      if (KEEPER_URL) setOrders(await keeperOrders(KEEPER_URL, owner));
    } catch (e) {
      setError(firstLine(e));
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function step(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
    setMessage(undefined);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(firstLine(e));
    } finally {
      setBusy(undefined);
    }
  }

  const deposit = () =>
    step("deposit", async () => {
      const amount = parseUnits(depositText, 6);
      const hash = await signer.deposit(amount);
      setMessage({
        text: `${formatUsdc(amount)} USDC deposited. Gateway credits it once ${network.base.label} finalizes the block, usually within minutes.`,
        tx: { chain: "base", hash },
      });
    });

  const signOrders = () =>
    step("orders", async () => {
      const value = parseUnits(orderValueText, 6);
      const signed: StandingOrder[] = [];
      for (let i = 0; i < orderCount; i++) {
        signed.push(await signOrder(signer, orderSpec(owner, account, value)));
      }
      const results = await sendToKeeper(KEEPER_URL, signed);
      const accepted = results.filter((r) => r.status === "accepted").length;
      const refused = results.find((r) => r.status === "rejected");
      setMessage({
        text: refused
          ? `${accepted} order(s) stored; the keeper refused one: ${refused.reason}`
          : `${accepted} standing order(s) of ${formatUsdc(value)} USDC stored by the keeper.`,
      });
    });

  const repayNow = () =>
    step("repay", async () => {
      setDelivered(false);
      const value = parseUnits(repayText, 6);
      const order = await signOrder(signer, orderSpec(owner, account, value));
      // Gateway takes its fee on top of the amount; checking the amount plus
      // the fee cap against a fresh reading of the reserve (a deposit is
      // credited minutes after the panel loaded) gives a clear message where
      // Gateway would answer "insufficient balance".
      const maxFee = BigInt(order.burnIntent.maxFee);
      const reserve = await gatewayBalance(owner);
      setBalance(reserve);
      if (value + maxFee > reserve) {
        const most = reserve > maxFee ? reserve - maxFee : 0n;
        throw new Error(
          `The reserve holds ${formatUsdc(reserve)} USDC and Gateway's fee cap (${formatUsdc(maxFee)} USDC) comes on top: repay at most ${formatUsdc(most)} USDC.`,
        );
      }
      const transferId = await submitToGateway(order);
      setMessage({ text: `${formatUsdc(value)} USDC on its way from ${network.base.label}…` });
      for (let i = 0; i < 100 && mounted.current; i++) {
        const status = await gatewayTransfer(transferId);
        if (status.state === "failed") throw new Error("Gateway could not deliver the transfer");
        if (status.state === "delivered") {
          setDelivered(true);
          setMessage({
            text: `${formatUsdc(value)} USDC arrived on your account. The keeper applies it to your debt, or apply it now.`,
            tx: status.txHash ? { chain: "arc", hash: status.txHash } : undefined,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (mounted.current) throw new Error("Still not delivered after 5 minutes; do not repay again before checking your account");
    });

  const applyNow = () =>
    step("sweep", async () => {
      const hash = await signer.sweep(account);
      setDelivered(false);
      setMessage({ text: "Applied to your debt.", tx: { chain: "arc", hash } });
    });

  // A passkey account signs through ERC-1271 on Base, which needs the account
  // deployed there: its first deposit does it, so signing waits for a reserve.
  const awaitingReserve = signer.prompt === "passkey" && !(balance !== undefined && balance > 0n);
  const total = orders?.reduce((sum, o) => sum + BigInt(o.value), 0n) ?? 0n;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="protection-title">
      <div>
        <h2 id="protection-title" className="text-xl font-semibold tracking-tight">
          Your reserve
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Keep USDC in Circle Gateway on {network.base.label}. If your margin falls under the guard&apos;s minimum, the
          keeper uses your standing orders to repay your debt instead of letting the position be liquidated. Orders can
          only pay your own Ardoise account.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-sunken p-4">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Gateway reserve</span>
          <span className="font-semibold tabular-nums">{balance === undefined ? "…" : `${formatUsdc(balance)} USDC`}</span>
        </div>
        <AmountAction
          value={depositText}
          onChange={setDepositText}
          label={busy === "deposit" ? confirming : `Deposit on ${network.base.label}`}
          disabled={busy !== undefined}
          onClick={deposit}
        />
        {signer.prompt === "passkey" && (
          <p className="text-xs text-faint">
            Your passkey account deposits from its own balance on {network.base.label}, at the same address: send it USDC
            {network.name === "mainnet" ? " and a little ETH for gas" : ""} on {network.base.label} first,{" "}
            <span className="font-mono break-all">{owner}</span>. The first deposit also deploys the account there, which
            Gateway needs to check its signatures.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-sunken p-4">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Standing orders held by the keeper</span>
          <span className="font-semibold tabular-nums">
            {!KEEPER_URL ? "not available" : orders === undefined ? "…" : `${orders.length} · ${formatUsdc(total)} USDC`}
          </span>
        </div>
        {KEEPER_URL ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              className="field px-3 py-2"
              value={orderCount}
              onChange={(e) => setOrderCount(Number(e.target.value))}
              aria-label="Number of orders"
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span>orders of</span>
            <AmountAction
              value={orderValueText}
              onChange={setOrderValueText}
              label={busy === "orders" ? confirming : "Sign"}
              disabled={busy !== undefined || awaitingReserve}
              onClick={signOrders}
            />
          </div>
        ) : (
          <p className="text-xs text-faint">
            {network.name === "mainnet"
              ? "Standing orders are signed from the app running next to the keeper, whose order intake only accepts local requests. Deposits and one-click repayment work here."
              : "The keeper relays standing orders on Arc mainnet only."}
          </p>
        )}
        <p className="text-xs text-faint">Each order is a signature, not a transaction: no gas. Valid about 70 days.</p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-sunken p-4">
        <span className="eyebrow">Repay now from the reserve</span>
        <AmountAction
          value={repayText}
          onChange={setRepayText}
          label={busy === "repay" ? "Delivering…" : "Repay"}
          disabled={busy !== undefined || awaitingReserve}
          onClick={repayNow}
        />
        {delivered && (
          <button
            type="button"
            onClick={applyNow}
            disabled={busy !== undefined}
            className="btn-secondary w-fit px-4 py-2 text-sm"
          >
            {busy === "sweep" ? confirming : "Apply to my debt now"}
          </button>
        )}
      </div>

      {message && (
        <p className="text-sm text-muted">
          {message.text}{" "}
          {message.tx && (
            <a
              className="underline"
              href={txUrl(message.tx.chain === "arc" ? network.arc : network.base, message.tx.hash)}
              target="_blank"
              rel="noreferrer"
            >
              transaction
            </a>
          )}
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}

function AmountAction(props: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        inputMode="decimal"
        className="field w-28 px-3 py-2 text-sm tabular-nums"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-label="Amount in USDC"
      />
      <span className="text-sm text-muted">USDC</span>
      <button
        type="button"
        onClick={props.onClick}
        disabled={props.disabled || !/^\d+(\.\d{1,6})?$/.test(props.value) || Number(props.value) <= 0}
        className="btn-primary px-4 py-2 text-sm"
      >
        {props.label}
      </button>
    </div>
  );
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}
