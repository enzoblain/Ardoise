"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { arcClient } from "@/lib/arc";
import type { Deployment } from "@/lib/contracts/deployments";
import { formatUsdc } from "@/lib/format";
import { network, txUrl } from "@/lib/network";
import { activationCalls, missingSteps, readSetup, runStep, type SetupState, type SetupStep } from "@/lib/setup";
import { CopyButton } from "@/components/CopyButton";
import { useVenueCheck, VenueWarning } from "@/components/VenueCheck";
import { sendFromPasskey, switchChain, type ConnectedWallet, type PasskeyWallet } from "@/lib/wallet";

// Allowance given to the shared adapter: three days at the default daily cap
// (20 USDC), finite as docs/api.md recommends. It shrinks as the adapter
// borrows and can be renewed here.
const BORROW_CAP = 60_000_000n;

// Gas a passkey account should hold before its activation on mainnet (native
// USDC, 18 decimals). The bundler checks the EntryPoint prefund, not the final
// cost: 0.106 USDC was prefunded for a single transfer in test 0.2, and the
// activation deploys the account and batches seven calls.
const MIN_GAS = 500_000_000_000_000_000n;

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
 * A passkey smart account instead supplies the cirBTC it holds and runs every
 * step in one user operation, with a single passkey signature.
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
  const venueCheck = useVenueCheck(deployment, state?.account ?? null);

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
    if (wallet.kind !== "browser") return;
    setRunning(step);
    setError(undefined);
    try {
      // The wallet may still be on Base after a deposit from the Protection panel.
      await switchChain(wallet.provider, network.arc.chain);
      setLastTx(await runStep(step, wallet.client, arcClient, deployment, BORROW_CAP));
      await refresh();
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setRunning(undefined);
    }
  }

  if (!state) return error ? <p className="text-sm text-danger">{error}</p> : <p className="text-sm text-muted">Reading your account…</p>;
  if (wallet.kind === "passkey") return <PasskeySetup wallet={wallet} deployment={deployment} state={state} refresh={refresh} />;
  const missing = missingSteps(state);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="setup-title">
      <h2 id="setup-title" className="text-xl font-semibold tracking-tight">
        Activate your account
      </h2>
      <p className="text-sm leading-relaxed text-muted">
        One-time setup on {network.arc.label}. Your cirBTC stays in your own Aave position: Ardoise can only borrow
        within the allowance below and repay.
      </p>
      <ol className="flex flex-col divide-y divide-line border-y border-line">
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
                  disabled={!next || running !== undefined || (step === "approveBorrow" && venueCheck.blocked)}
                  onClick={() => void run(step)}
                  className="btn-primary mt-2 w-fit px-4 py-2 text-sm"
                >
                  {running === step ? "Confirm in your wallet…" : "Do it"}
                </button>
              )}
            </Item>
          );
        })}
      </ol>
      <VenueWarning check={venueCheck} wallet={wallet} />
      {lastTx && (
        <p className="text-xs text-faint">
          Last step:{" "}
          <a className="underline" href={txUrl(network.arc, lastTx as `0x${string}`)} target="_blank" rel="noreferrer">
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}

/**
 * Setup of a passkey smart account: the account is funded by a transfer to
 * its address, then one passkey signature supplies the cirBTC, enables it as
 * collateral and runs every step in a single user operation.
 */
function PasskeySetup({
  wallet,
  deployment,
  state,
  refresh,
}: {
  wallet: PasskeyWallet;
  deployment: Deployment;
  state: SetupState;
  refresh: () => Promise<void>;
}) {
  const [gas, setGas] = useState<bigint>();
  const venueCheck = useVenueCheck(deployment, state.account);
  const [running, setRunning] = useState(false);
  const [lastTx, setLastTx] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    void arcClient.getBalance({ address: wallet.address }).then(
      (balance) => current && setGas(balance),
      () => current && setGas(undefined),
    );
    return () => {
      current = false;
    };
  }, [wallet.address, state]);

  const calls = activationCalls(state, deployment, wallet.address, BORROW_CAP);
  const funded = state.walletCirBtc > 0n || state.collateral > 0n;
  // On Arc mainnet the account pays its own gas in USDC; Circle's paymaster covers it on testnet only.
  const needsGas = network.name === "mainnet" && (gas === undefined || gas < MIN_GAS);

  async function activate() {
    setRunning(true);
    setError(undefined);
    try {
      setLastTx(await sendFromPasskey(wallet, calls));
      await refresh();
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="setup-title">
      <h2 id="setup-title" className="text-xl font-semibold tracking-tight">
        Activate your passkey account
      </h2>
      <p className="text-sm leading-relaxed text-muted">
        Your passkey owns a Circle smart account on {network.arc.label}. Send it cirBTC
        {network.name === "mainnet" ? " and a little USDC for gas" : ""}, then activate it with one signature: it
        supplies the cirBTC to your own Aave V4 position, enables it as collateral, creates your Ardoise account and
        allows it to borrow up to {formatUsdc(BORROW_CAP)} USDC.
      </p>
      <div className="flex flex-col gap-2 rounded-2xl border border-accent/40 bg-sunken p-4">
        <span className="eyebrow">
          Your smart account · send cirBTC{network.name === "mainnet" ? " and USDC" : ""} here, on {network.arc.label}
        </span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm break-all text-foreground">{wallet.address}</span>
          <CopyButton text={wallet.address} label="smart account address" />
        </div>
        <span className="text-xs text-faint">
          Same address on {network.base.label}, where the Protection panel keeps your Gateway reserve.
        </span>
      </div>
      <ol className="flex flex-col divide-y divide-line border-y border-line">
        <Item done={funded} label="cirBTC on the account">
          {state.collateral > 0n && <span>{formatUnits(state.collateral, 8)} cirBTC supplied on Aave V4. </span>}
          {state.walletCirBtc > 0n && <span>{formatUnits(state.walletCirBtc, 8)} cirBTC ready to supply. </span>}
          {!funded && <span>Send cirBTC to the address above. </span>}
        </Item>
        {network.name === "mainnet" && (
          <Item done={!needsGas} label="USDC for gas">
            {gas !== undefined && <span>{formatUnits(gas, 18)} USDC. </span>}
            {needsGas && <span>Send at least {formatUnits(MIN_GAS, 18)} USDC to the address above.</span>}
          </Item>
        )}
      </ol>
      <VenueWarning check={venueCheck} wallet={wallet} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!funded || needsGas || calls.length === 0 || running || venueCheck.blocked}
          onClick={() => void activate()}
          className="btn-primary w-fit px-4 py-2 text-sm"
        >
          {running ? "Confirm with your passkey…" : "Activate in one signature"}
        </button>
        <button type="button" className="text-sm text-muted underline" onClick={() => void refresh()}>
          Check the balances again
        </button>
      </div>
      {lastTx && (
        <p className="text-xs text-faint">
          Activation:{" "}
          <a className="underline" href={txUrl(network.arc, lastTx as `0x${string}`)} target="_blank" rel="noreferrer">
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}

function hasCollateral(state: SetupState): boolean {
  return state.collateral > 0n && state.collateralEnabled;
}

function Item({ done, label, children }: { done: boolean; label: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-3">
      <span
        aria-hidden
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-chalk text-background" : "border border-line-strong text-faint"}`}
      >
        {done ? "✓" : ""}
      </span>
      <span className="flex flex-col gap-0.5 text-sm">
        <span className={done ? "text-muted" : "font-medium"}>{label}</span>
        {children && <span className="text-faint">{children}</span>}
      </span>
    </li>
  );
}
