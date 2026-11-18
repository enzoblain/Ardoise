"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { arcClient } from "@/lib/arc";
import type { ArdoiseClient, Venue } from "@/lib/ardoise";
import { createChainArdoise } from "@/lib/chainArdoise";
import { deployment } from "@/lib/contracts/deployments";
import { createMockArdoise } from "@/lib/mockArdoise";
import { network } from "@/lib/network";
import { connectWallet, switchChain, type ConnectedWallet } from "@/lib/wallet";
import { AccountSetup } from "@/components/AccountSetup";
import { PayScreen } from "@/components/PayScreen";
import { ProtectionPanel } from "@/components/ProtectionPanel";
import { Statement } from "@/components/Statement";

/**
 * The account's views, sharing one account client: the pay screen and,
 * beside it (below on small screens), the statement each payment adds a line to.
 *
 * Without a wallet it runs the simulated demo account, so anyone can try the
 * flow. Once the owner connects a wallet on a network where the contracts
 * are deployed, it walks through the one-time setup, then switches to the
 * on-chain account and adds the Protection panel (Gateway reserve on Base).
 *
 * @param props.venues Venues with their live rates, read on the server.
 */
export function AccountScreen({ venues }: { venues: Venue[] }) {
  const demo = useMemo(() => createMockArdoise(venues), [venues]);
  const [wallet, setWallet] = useState<ConnectedWallet>();
  const [accountAddress, setAccountAddress] = useState<Address>();
  const [connectError, setConnectError] = useState<string>();
  const [payments, setPayments] = useState(0);

  const live = useMemo<ArdoiseClient | undefined>(
    () =>
      wallet && accountAddress && deployment
        ? createChainArdoise({
            publicClient: arcClient,
            walletClient: wallet.client,
            owner: wallet.address,
            account: accountAddress,
            venues,
            fromBlock: deployment.deployBlock,
            ensureArc: () => switchChain(wallet.provider, network.arc.chain),
          })
        : undefined,
    [wallet, accountAddress, venues],
  );
  const account = live ?? demo;

  // A different wallet account invalidates everything read so far. A network
  // switch does not: the Protection panel moves to Base to deposit and back,
  // reads go through the app's own Arc client, and viem refuses to send a
  // transaction while the wallet is on another chain than the one asked.
  useEffect(() => {
    if (!wallet) return;
    const reset = () => {
      setWallet(undefined);
      setAccountAddress(undefined);
    };
    wallet.provider.on("accountsChanged", reset);
    return () => {
      wallet.provider.removeListener("accountsChanged", reset);
    };
  }, [wallet]);

  async function connect() {
    setConnectError(undefined);
    try {
      setWallet(await connectWallet());
    } catch (e) {
      setConnectError((e as Error).message.split("\n")[0]);
    }
  }

  const onReady = useCallback((address: Address) => setAccountAddress(address), []);

  return (
    <>
      <ModeBar
        live={live !== undefined}
        wallet={wallet}
        account={accountAddress}
        onConnect={() => void connect()}
        onDisconnect={() => {
          setWallet(undefined);
          setAccountAddress(undefined);
        }}
      />
      {connectError && <p className="text-sm text-danger">{connectError}</p>}
      {live && <LiveNotices account={live} version={payments} />}
      {wallet && deployment && !accountAddress ? (
        <div className="card mx-auto w-full max-w-xl">
          <AccountSetup wallet={wallet} deployment={deployment} onReady={onReady} />
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="card" aria-label="Pay">
            <PayScreen key={live ? "live" : "demo"} account={account} venues={venues} onPaid={() => setPayments((n) => n + 1)} />
          </section>
          <div className="flex flex-col gap-6">
            <div className="card">
              <Statement key={live ? "live-statement" : "demo-statement"} account={account} venues={venues} version={payments} />
            </div>
            {live && wallet && accountAddress && (
              <div className="card">
                <ProtectionPanel provider={wallet.provider} owner={wallet.address} account={accountAddress} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ModeBar(props: {
  live: boolean;
  wallet?: ConnectedWallet;
  account?: Address;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (props.wallet) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3 text-sm">
        <span className="flex items-center gap-2.5 text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          <span>
            <span className="text-foreground">{props.live ? "Live account" : "Wallet connected"}</span> on{" "}
            {network.arc.label}: <span className="font-mono">{short(props.wallet.address)}</span>
            {props.account && (
              <>
                {" · account "}
                <span className="font-mono">{short(props.account)}</span>
              </>
            )}
          </span>
        </span>
        <button type="button" className="text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline" onClick={props.onDisconnect}>
          Back to the demo account
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3 text-sm">
      <span className="flex min-w-0 flex-1 basis-80 items-start gap-2.5 text-muted">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-chalk" aria-hidden />
        <span>
          <span className="text-foreground">Demo account.</span> The position, guard and payments are simulated in your
          browser; rates are live from Arc mainnet and fees are quoted by Circle.
        </span>
      </span>
      {deployment ? (
        <button type="button" onClick={props.onConnect} className="btn-primary shrink-0 px-4 py-2 text-sm">
          Connect wallet
        </button>
      ) : (
        <span className="text-faint">The contracts are deployed on Arc mainnet only.</span>
      )}
    </div>
  );
}

/** Warnings about the live account's guard: not deployed yet, or a simulated price drop on. */
function LiveNotices({ account, version }: { account: ArdoiseClient; version: number }) {
  const [guardMissing, setGuardMissing] = useState(false);
  const [dropBps, setDropBps] = useState(0);
  useEffect(() => {
    let current = true;
    void Promise.all([account.minHealthFactor(), account.simulatedDropBps()]).then(([min, drop]) => {
      if (!current) return;
      setGuardMissing(min === null);
      setDropBps(drop);
    });
    return () => {
      current = false;
    };
  }, [account, version]);
  return (
    <>
      {guardMissing && (
        <p className="rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3 text-sm">
          The position guard is not deployed yet, so the contracts refuse every payment. The screen below shows what a
          payment would do.
        </p>
      )}
      {dropBps > 0 && (
        <p className="rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3 text-sm font-medium">
          SIMULATION: bitcoin is treated as {(dropBps / 100).toFixed(2)}% lower than its real price. Margins and
          refusals below follow the simulated price.
        </p>
      )}
    </>
  );
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
