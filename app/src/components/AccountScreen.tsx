"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Address } from "viem";
import { arcClient } from "@/lib/arc";
import type { ArdoiseClient, Venue } from "@/lib/ardoise";
import { createChainArdoise } from "@/lib/chainArdoise";
import { deployment } from "@/lib/contracts/deployments";
import { createMockArdoise } from "@/lib/mockArdoise";
import { network } from "@/lib/network";
import { browserGatewaySigner, passkeyGatewaySigner } from "@/lib/gatewaySigner";
import { connectWallet, switchChain, type ConnectedWallet } from "@/lib/wallet";
import { Markets } from "@/components/Markets";
import { MyPositions } from "@/components/MyPositions";
import { NewPosition } from "@/components/NewPosition";
import { PayScreen } from "@/components/PayScreen";
import { VenueCheckNotice } from "@/components/VenueCheck";
import { Positions } from "@/components/Positions";
import type { AppTab } from "@/components/SiteHeader";
import { Statement } from "@/components/Statement";
import { StressTest } from "@/components/StressTest";
import { WithdrawPanel } from "@/components/WithdrawPanel";
import { useWalletState } from "@/lib/walletContext";

/**
 * The account's views, sharing one account client, on six tabs:
 * - My positions: one card per lender (collateral, debt, margin, borrowings
 *   in progress) and the protection the keeper repays with, then the
 *   statement and the withdrawal;
 * - Pay someone: borrow and pay a third party on Arc or Base;
 * - Collateral: the position on each lender and what can still be spent;
 * - Stress test: what a bitcoin fall would do;
 * - Markets: the lenders Ardoise borrows from, side by side, with a way to pay from one;
 * - New position: connecting a wallet (a browser wallet, or a passkey that
 *   owns a Circle smart account), the one-time setup, and the protection from
 *   Base (Gateway reserve): a browser wallet signs there itself, a passkey
 *   through the same smart account on Base.
 *
 * Without a wallet it runs the simulated demo account, so anyone can try the
 * flow; once the setup is done it switches to the on-chain account.
 *
 * The tabs are links in the site header (`/app?tab=…`): navigating between
 * them keeps this component, so the connected wallet stays connected.
 *
 * @param props.venues Venues with their live rates, read on the server.
 * @param props.tab The section to show.
 * @param props.autoConnect True when the page was opened with `?connect=wallet`.
 */
export function AccountScreen({ venues, tab, autoConnect }: { venues: Venue[]; tab: AppTab; autoConnect: boolean }) {
  const router = useRouter();
  const setTab = useCallback((next: AppTab) => router.push(`/app?tab=${next}`), [router]);
  // Created once: the server sends fresh venue objects on every section
  // change, and a new demo account would drop the payments made so far.
  const [demo] = useState(() => createMockArdoise(venues));
  // Shared with the header (which shows the wallet), so it survives section changes.
  const shared = useWalletState();
  const [localWallet, setLocalWallet] = useState<ConnectedWallet>();
  const [localAccount, setLocalAccount] = useState<Address>();
  const wallet = shared ? shared.wallet : localWallet;
  const setWallet = shared ? shared.setWallet : setLocalWallet;
  const accountAddress = shared ? shared.accountAddress : localAccount;
  const setAccountAddress = shared ? shared.setAccountAddress : setLocalAccount;
  const [connectError, setConnectError] = useState<string>();
  const [payments, setPayments] = useState(0);
  const [unexpectedVenue, setUnexpectedVenue] = useState(false);
  // Venue picked on the Markets tab, which the pay screen starts on.
  const [pickedVenue, setPickedVenue] = useState<string>();

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
  const account = live ?? demo;
  // A venue warning belongs to the live account: back on the demo account, Pay is usable again.
  useEffect(() => {
    if (!live) setUnexpectedVenue(false);
  }, [live]);
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
  }, [wallet, setWallet, setAccountAddress]);

  async function connect(how: () => Promise<ConnectedWallet>) {
    setConnectError(undefined);
    try {
      setWallet(await how());
      setTab("new");
    } catch (e) {
      setConnectError((e as Error).message.split("\n")[0]);
    }
  }

  // The header's "Connect wallet" links here with `?connect=wallet`, also
  // from inside the app, where the page is not reloaded: the prop changes,
  // so the browser wallet opens each time the link is followed.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (!autoConnect) {
      autoConnected.current = false;
      return;
    }
    if (autoConnected.current) return;
    autoConnected.current = true;
    // Drop the parameter so that a reload does not open the wallet prompt again.
    router.replace("/app?tab=new");
    connectWallet().then(setWallet, (e: Error) => setConnectError(e.message.split("\n")[0]));
  }, [autoConnect, router, setWallet]);

  const onReady = useCallback((address: Address) => setAccountAddress(address), [setAccountAddress]);

  return (
    <>
      <ModeBar
        live={live !== undefined}
        wallet={wallet}
        account={accountAddress}
        onNew={() => setTab("new")}
        onDisconnect={() => {
          setWallet(undefined);
          setAccountAddress(undefined);
        }}
      />
      {connectError && <p className="text-sm text-danger">{connectError}</p>}
      {live && <LiveNotices account={live} version={payments} />}
      {live && wallet && accountAddress && deployment && <VenueCheckNotice wallet={wallet} deployment={deployment} account={accountAddress} onUnexpected={setUnexpectedVenue} />}
      {tab === "new" ? (
        <NewPosition
          wallet={wallet}
          account={accountAddress}
          deployment={deployment}
          signer={live ? gatewaySigner : undefined}
          onConnect={() => void connect(connectWallet)}
          // Circle's SDK is large: loaded only once the user picks a passkey.
          onPasskey={(mode, username) => void connect(async () => (await import("@/lib/passkey")).connectPasskey(mode, username))}
          onReady={onReady}
          live={live}
          venues={venues}
          onPaid={() => setPayments((n) => n + 1)}
        />
      ) : tab === "markets" ? (
        <Markets
          venues={venues}
          onPick={(venueId) => {
            setPickedVenue(venueId);
            setTab("pay");
          }}
        />
      ) : tab === "collateral" ? (
        <section className="card" aria-label="Collateral on each lender">
          <Positions key={live ? "live-positions" : "demo-positions"} account={account} venues={venues} version={payments} />
        </section>
      ) : tab === "stress" ? (
        <section className="card" aria-label="Stress test">
          <StressTest
            key={live ? "live-stress" : "demo-stress"}
            account={account}
            venues={venues}
            owner={live ? wallet?.address : undefined}
            accountAddress={live ? accountAddress : undefined}
            version={payments}
          />
        </section>
      ) : tab === "pay" ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <p className="text-sm text-muted">
            Pay someone on Arc or on Base with money borrowed on your positions: the USDC goes straight to them, and the debt
            is added to the lender you pick (or the cheapest one the guard allows). Your collateral never moves. To borrow to
            your own wallet instead, use New position.
          </p>
          <section className={unexpectedVenue ? "card opacity-50" : "card"} aria-label="Pay someone" inert={unexpectedVenue}>
            <PayScreen
              key={`${live ? "live" : "demo"}-${pickedVenue ?? "best"}`}
              account={account}
              venues={venues}
              initialVenueId={pickedVenue}
              title="Pay someone"
              onPaid={() => setPayments((n) => n + 1)}
            />
          </section>
        </div>
      ) : (
        <>
          <MyPositions
            key={live ? "live-my" : "demo-my"}
            account={account}
            venues={venues}
            version={payments}
            owner={live ? wallet?.address : undefined}
            accountAddress={live ? accountAddress : undefined}
          />
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="card">
              <Statement key={live ? "live-statement" : "demo-statement"} account={account} venues={venues} version={payments} />
            </div>
            {live && wallet && accountAddress && (
              <div className="card">
                <WithdrawPanel wallet={wallet} account={accountAddress} version={payments} />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function ModeBar(props: {
  live: boolean;
  wallet?: ConnectedWallet;
  account?: Address;
  onNew: () => void;
  onDisconnect: () => void;
}) {
  if (props.wallet) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3 text-sm">
        <span className="flex items-center gap-2.5 text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          <span>
            <span className="text-foreground">{props.live ? "Live account" : "Wallet connected"}</span> on{" "}
            {network.arc.label}
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
        <button type="button" onClick={props.onNew} className="btn-primary shrink-0 px-4 py-2 text-sm">
          Open a live position
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
