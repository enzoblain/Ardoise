"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { arcClient } from "@/lib/arc";
import { formatUsdc } from "@/lib/format";
import {
  depositAbi,
  gateway,
  gatewayBalance,
  gatewayTransfer,
  keeperOrders,
  orderSpec,
  sendToKeeper,
  signOrder,
  submitToGateway,
  sweepAbi,
  type OrderSummary,
  type StandingOrder,
} from "@/lib/gateway";
import { network, txUrl } from "@/lib/network";
import { switchChain } from "@/lib/wallet";

/**
 * The keeper's standing-order intake; public, it holds no secret. The keeper
 * relays orders on Arc mainnet only, so the section is hidden elsewhere.
 */
const KEEPER_URL = network.name === "mainnet" ? process.env.NEXT_PUBLIC_KEEPER_URL || "" : "";
/** Standing orders are signed with twice the estimated fee cap (see `signOrder`). */
const STANDING_FEE_HEADROOM = 2n;
const POLL_MS = 3_000;

/**
 * Protection from the user's dollars on Base (B4): the Gateway reserve,
 * the standing orders the keeper may use when the margin gets too low, and
 * a one-click repayment from that reserve.
 *
 * @param props.provider Browser wallet of the owner.
 * @param props.owner Owner of the account and depositor on Gateway.
 * @param props.account The owner's Ardoise account, the only recipient orders may name.
 */
export function ProtectionPanel({ provider, owner, account }: { provider: EIP1193Provider; owner: Address; account: Address }) {
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

  const signer = createWalletClient({ account: owner, transport: custom(provider) });

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
      const chain = network.base.chain;
      await switchChain(provider, chain);
      try {
        const wallet = createWalletClient({ account: owner, chain, transport: custom(provider) });
        const base = createPublicClient({ chain, transport: http() });
        const approval = await wallet.writeContract({
          address: gateway.sourceUsdc,
          abi: depositAbi,
          functionName: "approve",
          args: [gateway.walletContract, amount],
        });
        await base.waitForTransactionReceipt({ hash: approval });
        const hash = await wallet.writeContract({
          address: gateway.walletContract,
          abi: depositAbi,
          functionName: "deposit",
          args: [gateway.sourceUsdc, amount],
        });
        await base.waitForTransactionReceipt({ hash });
        setMessage({
          text: `${formatUsdc(amount)} USDC deposited. Gateway credits it once ${network.base.label} finalizes the block, usually within minutes.`,
          tx: { chain: "base", hash },
        });
      } finally {
        // The rest of the app signs on Arc.
        await switchChain(provider, network.arc.chain).catch(() => undefined);
      }
    });

  const signOrders = () =>
    step("orders", async () => {
      const value = parseUnits(orderValueText, 6);
      const signed: StandingOrder[] = [];
      for (let i = 0; i < orderCount; i++) {
        signed.push(await signOrder(signer, orderSpec(owner, account, value), STANDING_FEE_HEADROOM));
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
      const transferId = await submitToGateway(await signOrder(signer, orderSpec(owner, account, value)));
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
      await switchChain(provider, network.arc.chain);
      const wallet = createWalletClient({ account: owner, chain: network.arc.chain, transport: custom(provider) });
      const hash = await wallet.writeContract({ address: account, abi: sweepAbi, functionName: "sweep" });
      await arcClient.waitForTransactionReceipt({ hash });
      setDelivered(false);
      setMessage({ text: "Applied to your debt.", tx: { chain: "arc", hash } });
    });

  const total = orders?.reduce((sum, o) => sum + BigInt(o.value), 0n) ?? 0n;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="protection-title">
      <div>
        <h2 id="protection-title" className="text-xl font-semibold">
          Protection from {network.base.label}
        </h2>
        <p className="text-sm opacity-80">
          Keep USDC in Circle Gateway on {network.base.label}. If your margin falls under the guard&apos;s minimum, the
          keeper uses your standing orders to repay your debt instead of letting the position be liquidated. Orders can
          only pay your own Ardoise account.
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
        <div className="flex items-baseline justify-between">
          <span className="text-sm opacity-70">Gateway reserve on {network.base.label}</span>
          <span className="font-semibold tabular-nums">{balance === undefined ? "…" : `${formatUsdc(balance)} USDC`}</span>
        </div>
        <AmountAction
          value={depositText}
          onChange={setDepositText}
          label={busy === "deposit" ? "Confirm in your wallet…" : `Deposit on ${network.base.label}`}
          disabled={busy !== undefined}
          onClick={deposit}
        />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
        <div className="flex items-baseline justify-between">
          <span className="text-sm opacity-70">Standing orders held by the keeper</span>
          <span className="font-semibold tabular-nums">
            {!KEEPER_URL ? "not available" : orders === undefined ? "…" : `${orders.length} · ${formatUsdc(total)} USDC`}
          </span>
        </div>
        {KEEPER_URL ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/20"
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
              label={busy === "orders" ? "Sign in your wallet…" : "Sign"}
              disabled={busy !== undefined}
              onClick={signOrders}
            />
          </div>
        ) : (
          <p className="text-xs opacity-60">
            {network.name === "mainnet"
              ? "Set NEXT_PUBLIC_KEEPER_URL to the keeper's order intake to sign orders here."
              : "The keeper relays standing orders on Arc mainnet only."}
          </p>
        )}
        <p className="text-xs opacity-60">Each order is a signature, not a transaction: no gas. Valid about 70 days.</p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
        <span className="text-sm opacity-70">Repay now from {network.base.label}</span>
        <AmountAction
          value={repayText}
          onChange={setRepayText}
          label={busy === "repay" ? "Delivering…" : "Repay"}
          disabled={busy !== undefined}
          onClick={repayNow}
        />
        {delivered && (
          <button
            type="button"
            onClick={applyNow}
            disabled={busy !== undefined}
            className="w-fit rounded-lg border border-current px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          >
            {busy === "sweep" ? "Confirm in your wallet…" : "Apply to my debt now"}
          </button>
        )}
      </div>

      {message && (
        <p className="text-sm">
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
      {error && <p className="text-sm text-red-600">{error}</p>}
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
        className="w-24 rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm tabular-nums dark:border-white/20"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-label="Amount in USDC"
      />
      <span className="text-sm opacity-60">USDC</span>
      <button
        type="button"
        onClick={props.onClick}
        disabled={props.disabled || !/^\d+(\.\d{1,6})?$/.test(props.value) || Number(props.value) <= 0}
        className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-40"
      >
        {props.label}
      </button>
    </div>
  );
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}
