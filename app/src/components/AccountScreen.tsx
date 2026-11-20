"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { arcClient } from "@/lib/arc";
import type { ArdoiseClient, Venue } from "@/lib/ardoise";
import { createChainArdoise } from "@/lib/chainArdoise";
import { deployment } from "@/lib/contracts/deployments";
import { network } from "@/lib/network";
import { browserGatewaySigner, passkeyGatewaySigner } from "@/lib/gatewaySigner";
import { connectWallet, switchChain, type ConnectedWallet } from "@/lib/wallet";
import { AccountSetup } from "@/components/AccountSetup";
import { VenueCheckNotice } from "@/components/VenueCheck";
import { PayScreen } from "@/components/PayScreen";
import { ProtectionPanel } from "@/components/ProtectionPanel";
import { Statement } from "@/components/Statement";
import { StressTest } from "@/components/StressTest";
import { WithdrawPanel } from "@/components/WithdrawPanel";

/** The account's views, one per tab. */
const TABS = [
  { id: "pay", label: "Pay" },
  { id: "statement", label: "Statement" },
  { id: "protection", label: "Protection" },
  { id: "stress", label: "Stress test" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * The owner's account. The page asks first for a wallet (a browser wallet, or
 * a passkey that owns a Circle smart account), then walks through the
 * one-time setup, then shows the on-chain account in tabs: pay, the
 * statement each payment adds a line to, protection (Gateway reserve on Base
 * and withdrawal of idle USDC) and the stress test. A browser wallet signs on
 * Base itself, a passkey through the same smart account on Base.
 *
 * @param props.venues Venues with their live rates, read on the server.
 */
export function AccountScreen({ venues }: { venues: Venue[] }) {
  const [wallet, setWallet] = useState<ConnectedWallet>();
  const [accountAddress, setAccountAddress] = useState<Address>();
  const [connectError, setConnectError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [payments, setPayments] = useState(0);
  const [unexpectedVenue, setUnexpectedVenue] = useState(false);
  const [tab, setTab] = useState<Tab>("pay");

  const live = useMemo<ArdoiseClient | undefined>(
    () =>
      wallet && accountAddress && deployment
        ? createChainArdoise({
            publicClient: arcClient,
            walletClient: wallet.kind === "browser" ? wallet.client : null,
            smartAccount: wallet.kind === "passkey" ? wallet : undefined,
            owner: wallet.address,
            account: accountAddress,
            venues,
            fromBlock: deployment.deployBlock,
            eventsUrl: "/api/account-events",
            ensureArc: wallet.kind === "browser" ? () => switchChain(wallet.provider, network.arc.chain) : undefined,
          })
        : undefined,
    [wallet, accountAddress, venues],
  );
  const gatewaySigner = useMemo(
    () => (wallet ? (wallet.kind === "browser" ? browserGatewaySigner(wallet.provider, wallet.address) : passkeyGatewaySigner(wallet)) : undefined),
    [wallet],
  );

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

  // The tab is kept in the URL (`?tab=statement`), so a reload or a shared
  // link opens the same view.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("tab");
    if (TABS.some((t) => t.id === asked)) setTab(asked as Tab);
  }, []);
  function openTab(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  const connect = useCallback(async (how: () => Promise<ConnectedWallet>) => {
    setConnectError(undefined);
    setConnecting(true);
    try {
      setWallet(await how());
    } catch (e) {
      setConnectError((e as Error).message.split("\n")[0]);
    } finally {
      setConnecting(false);
    }
  }, []);

  // The landing page's "Connect wallet" button links here with
  // `?connect=wallet`: open the browser wallet straight away, once.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (autoConnected.current || new URLSearchParams(window.location.search).get("connect") !== "wallet") return;
    autoConnected.current = true;
    // Drop the parameter so that a reload does not open the wallet prompt again.
    const url = new URL(window.location.href);
    url.searchParams.delete("connect");
    window.history.replaceState(null, "", url);
    void connect(connectWallet);
  }, [connect]);

  const onReady = useCallback((address: Address) => setAccountAddress(address), []);
  const disconnect = () => {
    setWallet(undefined);
    setAccountAddress(undefined);
  };

  if (!deployment) {
    return <p className="card mx-auto w-full max-w-xl text-muted">The contracts are deployed on Arc mainnet only: set the app to mainnet to open an account.</p>;
  }
  if (!wallet) {
    return (
      <ConnectScreen
        connecting={connecting}
        error={connectError}
        onConnect={() => void connect(connectWallet)}
        // Circle's SDK is large: loaded only once the user picks a passkey.
        onPasskey={(mode, username) => void connect(async () => (await import("@/lib/passkey")).connectPasskey(mode, username))}
      />
    );
  }

  return (
    <>
      <AccountBar wallet={wallet} account={accountAddress} onDisconnect={disconnect} />
      {!accountAddress || !live ? (
        <div className="card mx-auto w-full max-w-xl">
          <AccountSetup wallet={wallet} deployment={deployment} onReady={onReady} />
        </div>
      ) : (
        <>
          <LiveNotices account={live} version={payments} />
          <VenueCheckNotice wallet={wallet} deployment={deployment} account={accountAddress} onUnexpected={setUnexpectedVenue} />
          <nav role="tablist" aria-label="Account views" className="flex gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                onClick={() => openTab(t.id)}
                className={`flex-1 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                  tab === t.id ? "bg-foreground text-background" : "text-muted hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          {/* Every view stays mounted, so a form being filled in survives a tab switch. */}
          <TabPanel id="pay" active={tab}>
            <section className={unexpectedVenue ? "card mx-auto w-full max-w-2xl opacity-50" : "card mx-auto w-full max-w-2xl"} aria-label="Pay" inert={unexpectedVenue}>
              <PayScreen account={live} venues={venues} onPaid={() => setPayments((n) => n + 1)} />
            </section>
          </TabPanel>
          <TabPanel id="statement" active={tab}>
            <div className="card">
              <Statement account={live} venues={venues} version={payments} />
            </div>
          </TabPanel>
          <TabPanel id="protection" active={tab}>
            <div className="grid items-start gap-6 lg:grid-cols-2">
              {gatewaySigner && (
                <div className="card">
                  <ProtectionPanel signer={gatewaySigner} account={accountAddress} />
                </div>
              )}
              <div className="card">
                <WithdrawPanel wallet={wallet} account={accountAddress} version={payments} />
              </div>
            </div>
          </TabPanel>
          <TabPanel id="stress" active={tab}>
            <section className="card" aria-label="Stress test">
              <StressTest account={live} venues={venues} owner={wallet.address} accountAddress={accountAddress} version={payments} />
            </section>
          </TabPanel>
        </>
      )}
    </>
  );
}

function TabPanel({ id, active, children }: { id: Tab; active: Tab; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={active !== id}>
      {children}
    </div>
  );
}

// Passkeys need a Circle client key (registered for this domain); without one, only browser wallets are offered.
const passkeysEnabled = Boolean(process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY);

/** The first screen: connect a browser wallet, or sign in or create a passkey. */
function ConnectScreen(props: {
  connecting: boolean;
  error?: string;
  onConnect: () => void;
  onPasskey: (mode: "register" | "login", username: string) => void;
}) {
  const [username, setUsername] = useState("");
  return (
    <div className="card mx-auto flex w-full max-w-md flex-col gap-6 py-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Open your account</h2>
        <p className="text-sm text-muted">
          Connect the wallet that holds your cirBTC on {network.arc.label}. Ardoise borrows against it to pay, and guards
          the position.
        </p>
      </div>
      <button type="button" onClick={props.onConnect} disabled={props.connecting} className="btn-primary px-4 py-3">
        {props.connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {passkeysEnabled && (
        <div className="flex flex-col gap-3 border-t border-line pt-5">
          <p className="text-xs uppercase tracking-widest text-muted">Or with a passkey</p>
          <button type="button" onClick={() => props.onPasskey("login", "")} disabled={props.connecting} className="btn-secondary px-4 py-2.5">
            Sign in with a passkey
          </button>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (username.trim()) props.onPasskey("register", username.trim());
            }}
          >
            <input
              aria-label="Passkey name"
              placeholder="Name for a new passkey"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-line bg-background px-3 py-2 text-sm"
            />
            <button type="submit" disabled={!username.trim() || props.connecting} className="btn-secondary shrink-0 px-4 py-2 text-sm">
              Create
            </button>
          </form>
        </div>
      )}
      {props.error && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm">
          {props.error}
        </p>
      )}
    </div>
  );
}

/** Who is connected, with a way out. */
function AccountBar(props: { wallet: ConnectedWallet; account?: Address; onDisconnect: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3 text-sm">
      <span className="flex items-center gap-2.5 text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        <span>
          <span className="text-foreground">{props.account ? "Live account" : "Wallet connected"}</span> on {network.arc.label}
          {props.wallet.kind === "passkey" && <> with {props.wallet.username ? `passkey “${props.wallet.username}”` : "a passkey"}</>}:{" "}
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
        Disconnect
      </button>
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
