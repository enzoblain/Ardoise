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
 * below it, the statement each payment adds a line to.
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
      {connectError && <p className="text-sm text-red-600">{connectError}</p>}
      {live && <LiveNotices account={live} version={payments} />}
      {wallet && deployment && !accountAddress ? (
        <AccountSetup wallet={wallet} deployment={deployment} onReady={onReady} />
      ) : (
        <>
          <PayScreen key={live ? "live" : "demo"} account={account} venues={venues} onPaid={() => setPayments((n) => n + 1)} />
          <Statement key={live ? "live-statement" : "demo-statement"} account={account} venues={venues} version={payments} />
          {live && wallet && accountAddress && (
            <ProtectionPanel provider={wallet.provider} owner={wallet.address} account={accountAddress} />
          )}
        </>
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
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm">
        <span>
          {props.live ? "Live account on " : "Wallet on "}
          {network.arc.label}: <span className="font-mono">{short(props.wallet.address)}</span>
          {props.account && (
            <>
              {" · account "}
              <span className="font-mono">{short(props.account)}</span>
            </>
          )}
        </span>
        <button type="button" className="underline" onClick={props.onDisconnect}>
          Back to the demo account
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-500/15 px-3 py-2 text-sm">
      <span>
        Demo account: the position, guard and payments are simulated in your browser. Rates are live from Arc mainnet;
        fees are quoted by Circle.
      </span>
      {deployment ? (
        <button
          type="button"
          onClick={props.onConnect}
          className="rounded-lg bg-foreground px-3 py-1.5 font-medium text-background"
        >
          Connect wallet
        </button>
      ) : (
        <span className="opacity-70">The contracts are deployed on Arc mainnet only.</span>
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
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm">
          The position guard is not deployed yet, so the contracts refuse every payment. The screen below shows what a
          payment would do.
        </p>
      )}
      {dropBps > 0 && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm font-medium">
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
