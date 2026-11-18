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
 * flow. Once the owner connects a wallet (a browser wallet, or a passkey that
 * owns a Circle smart account) on a network where the contracts are deployed,
 * it walks through the one-time setup, then switches to the on-chain account.
 * A browser wallet also gets the Protection panel (Gateway reserve on Base),
 * which signs on Base and so needs a wallet that can switch chains.
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
            walletClient: wallet.kind === "browser" ? wallet.client : null,
            sendCalls: wallet.kind === "passkey" ? wallet.send : undefined,
            owner: wallet.address,
            account: accountAddress,
            venues,
            fromBlock: deployment.deployBlock,
            ensureArc: wallet.kind === "browser" ? () => switchChain(wallet.provider, network.arc.chain) : undefined,
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
    if (wallet?.kind !== "browser") return;
    const reset = () => {
      setWallet(undefined);
      setAccountAddress(undefined);
    };
    wallet.provider.on("accountsChanged", reset);
    return () => {
      wallet.provider.removeListener("accountsChanged", reset);
    };
  }, [wallet]);

  async function connect(how: () => Promise<ConnectedWallet>) {
    setConnectError(undefined);
    try {
      setWallet(await how());
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
        onConnect={() => void connect(connectWallet)}
        // Circle's SDK is large: loaded only once the user picks a passkey.
        onPasskey={(mode, username) => void connect(async () => (await import("@/lib/passkey")).connectPasskey(mode, username))}
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
            {live && wallet?.kind === "browser" && accountAddress && (
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

// Passkeys need a Circle client key (registered for this domain); without one, only browser wallets are offered.
const passkeysEnabled = Boolean(process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY);

function ModeBar(props: {
  live: boolean;
  wallet?: ConnectedWallet;
  account?: Address;
  onConnect: () => void;
  onPasskey: (mode: "register" | "login", username: string) => void;
  onDisconnect: () => void;
}) {
  const [username, setUsername] = useState("");
  if (props.wallet) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3 text-sm">
        <span className="flex items-center gap-2.5 text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          <span>
            <span className="text-foreground">{props.live ? "Live account" : "Wallet connected"}</span> on{" "}
            {network.arc.label}
            {props.wallet.kind === "passkey" && <> with passkey “{props.wallet.username}”</>}:{" "}
            <span className="font-mono">{short(props.wallet.address)}</span>
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
        <span className="flex flex-wrap items-center gap-2">
          {passkeysEnabled && (
            <>
              <button type="button" onClick={() => props.onPasskey("login", "")} className="btn-secondary shrink-0 px-4 py-2 text-sm">
                Sign in with passkey
              </button>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (username.trim()) props.onPasskey("register", username.trim());
                }}
              >
                <input
                  aria-label="Passkey name"
                  placeholder="New passkey name"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-40 rounded-xl border border-line bg-background px-3 py-2 text-sm"
                />
                <button type="submit" disabled={!username.trim()} className="btn-secondary shrink-0 px-4 py-2 text-sm">
                  Create
                </button>
              </form>
            </>
          )}
          <button type="button" onClick={props.onConnect} className="btn-primary shrink-0 px-4 py-2 text-sm">
            Connect wallet
          </button>
        </span>
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
