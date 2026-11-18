"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { arcClient } from "@/lib/arc";
import type { Deployment } from "@/lib/contracts/deployments";
import { formatUsdc } from "@/lib/format";
import { network, txUrl } from "@/lib/network";
import { missingSteps, readSetup, runStep, type SetupState, type SetupStep } from "@/lib/setup";
import type { ConnectedWallet } from "@/lib/wallet";

// Allowance given to the shared adapter: three days at the default daily cap
// (20 USDC), finite as docs/api.md recommends. It shrinks as the adapter
// borrows and can be renewed here.
const BORROW_CAP = 60_000_000n;

const STEP_LABELS: Record<SetupStep, string> = {
  approveTaker: "Let Aave's Taker borrow on your behalf",
  approveGiver: "Let Aave's Giver repay on your behalf",
  createAccount: "Create your Ardoise account",
  approveBorrow: `Allow Ardoise to borrow up to ${formatUsdc(BORROW_CAP)} USDC on Aave V4`,
};

/**
 * One-time setup of a wallet on Arc (docs/api.md, *One-time user setup on
 * Aave V4*): shows each step's state and runs the missing ones from the
 * wallet, one transaction each. Supplying cirBTC stays on Aave's side.
 *
 * @param props.wallet Connected owner wallet.
 * @param props.deployment Deployed addresses.
 * @param props.onReady Called with the account once every step is done.
 */
export function AccountSetup({
  wallet,
  deployment,
  onReady,
}: {
  wallet: ConnectedWallet;
  deployment: Deployment;
  onReady: (account: Address) => void;
}) {
  const [state, setState] = useState<SetupState>();
  const [running, setRunning] = useState<SetupStep>();
  const [lastTx, setLastTx] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const next = await readSetup(arcClient, deployment, wallet.address);
      setState(next);
      setError(undefined);
      if (next.account !== null && missingSteps(next).length === 0 && hasCollateral(next)) onReady(next.account);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [deployment, wallet.address, onReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(step: SetupStep) {
    setRunning(step);
    setError(undefined);
    try {
      setLastTx(await runStep(step, wallet.client, arcClient, deployment, BORROW_CAP));
      await refresh();
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setRunning(undefined);
    }
  }

  if (!state) return error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm opacity-70">Reading your account…</p>;
  const missing = missingSteps(state);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="setup-title">
      <h2 id="setup-title" className="text-xl font-semibold">
        Activate your account
      </h2>
      <p className="text-sm opacity-80">
        One-time setup on {network.arc.label}. Your cirBTC stays in your own Aave position: Ardoise can only borrow
        within the allowance below and repay.
      </p>
      <ol className="flex flex-col gap-3">
        <Item done={hasCollateral(state)} label="cirBTC supplied as collateral on Aave V4">
          {hasCollateral(state) ? (
            <span>{formatUnits(state.collateral, 8)} cirBTC</span>
          ) : (
            <span>
              Supply cirBTC on the Aave V4 Main Spoke and enable it as collateral, then{" "}
              <button type="button" className="underline" onClick={() => void refresh()}>
                check again
              </button>
              .
            </span>
          )}
        </Item>
        {(["approveTaker", "approveGiver", "createAccount", "approveBorrow"] as const).map((step) => {
          const done = !missing.includes(step);
          const next = missing[0] === step;
          return (
            <Item key={step} done={done} label={STEP_LABELS[step]}>
              {step === "createAccount" && state.account && <span className="font-mono">{state.account}</span>}
              {step === "approveBorrow" && done && <span>{formatUsdc(state.borrowAllowance)} USDC left</span>}
              {!done && (
                <button
                  type="button"
                  disabled={!next || running !== undefined}
                  onClick={() => void run(step)}
                  className="mt-1 w-fit rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-40"
                >
                  {running === step ? "Confirm in your wallet…" : "Do it"}
                </button>
              )}
            </Item>
          );
        })}
      </ol>
      {lastTx && (
        <p className="text-xs opacity-70">
          Last step:{" "}
          <a className="underline" href={txUrl(network.arc, lastTx as `0x${string}`)} target="_blank" rel="noreferrer">
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

function hasCollateral(state: SetupState): boolean {
  return state.collateral > 0n && state.collateralEnabled;
}

function Item({ done, label, children }: { done: boolean; label: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="w-4 text-center font-mono">
        {done ? "✓" : "○"}
      </span>
      <span className="flex flex-col gap-0.5 text-sm">
        <span className={done ? "" : "font-medium"}>{label}</span>
        {children && <span className="opacity-70">{children}</span>}
      </span>
    </li>
  );
}
