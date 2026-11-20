"use client";

import { useState } from "react";
import type { Address } from "viem";
import { AccountSetup } from "@/components/AccountSetup";
import { AddCollateral } from "@/components/AddCollateral";
import { PayScreen } from "@/components/PayScreen";
import type { ArdoiseClient, Venue } from "@/lib/ardoise";
import { ProtectionPanel } from "@/components/ProtectionPanel";
import type { Deployment } from "@/lib/contracts/deployments";
import type { GatewaySigner } from "@/lib/gatewaySigner";
import { network } from "@/lib/network";
import type { ConnectedWallet } from "@/lib/wallet";

// Passkeys need a Circle client key (registered for this domain); without one, only browser wallets are offered.
const passkeysEnabled = Boolean(process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY);

/**
 * Opening a new borrowing, centred: connecting a wallet (browser wallet or
 * passkey) until one is connected, then the one-time setup on Aave V4 and
 * the account until it is done; then three cards: put up cirBTC collateral
 * on Aave V4 or Morpho, borrow USDC to the owner's wallet, and set aside USDC
 * on Base (Gateway reserve, standing orders) that the keeper repays with.
 *
 * @param props.wallet The connected wallet, if any.
 * @param props.account The owner's Ardoise account once the setup is done.
 * @param props.deployment The contracts of the selected network, or `null` where nothing is deployed.
 * @param props.signer Signs Gateway deposits and orders for the connected wallet.
 * @param props.onConnect Connects a browser wallet.
 * @param props.onPasskey Signs in with, or creates, a passkey.
 * @param props.onReady Called with the account address once the setup is done.
 * @param props.live The on-chain account client once the setup is done.
 * @param props.venues Venues with their live rates.
 * @param props.onPaid Called after collateral is added or USDC borrowed, to read again.
 * @param props.locked Locks borrowing while an unexpected venue is accepted.
 */
export function NewPosition(props: {
  wallet?: ConnectedWallet;
  account?: Address;
  deployment: Deployment | null;
  signer?: GatewaySigner;
  onConnect: () => void;
  onPasskey: (mode: "register" | "login", username: string) => void;
  onReady: (account: Address) => void;
  live?: ArdoiseClient;
  venues: Venue[];
  onPaid: () => void;
  /** True while the account has accepted a venue the app does not expect: borrowing is locked. */
  locked?: boolean;
}) {
  const { wallet, account, deployment } = props;
  const [username, setUsername] = useState("");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <p className="eyebrow">On {network.arc.label}</p>
        <h2 className="text-2xl font-semibold tracking-tight">New position</h2>
        <p className="mt-1 text-sm text-muted">
          Your cirBTC stays in your own lending position. Ardoise only gets the right to borrow USDC for your payments,
          within caps, and a guard refuses any payment that would leave less than the minimum margin.
        </p>
      </div>

      {account && wallet && deployment ? (
        <>
          <section className="card flex flex-col gap-3" aria-label="Collateral">
            <h2 className="text-lg font-semibold">1 · Put up collateral</h2>
            <p className="text-sm text-muted">Add cirBTC to your position on the lender you will borrow from.</p>
            <AddCollateral wallet={wallet} deployment={deployment} onDone={props.onPaid} />
          </section>
          <section className={`card flex flex-col gap-3 ${props.locked ? "opacity-50" : ""}`} aria-label="Borrow" inert={props.locked}>
            {props.live ? (
              <PayScreen
                key={`borrow-${wallet.address}`}
                account={props.live}
                venues={props.venues}
                toSelf={wallet.address}
                title="2 · Borrow to my wallet"
                onPaid={props.onPaid}
              />
            ) : (
              <p className="text-sm text-muted">Reading your account…</p>
            )}
          </section>
          <section className="card flex flex-col gap-3" aria-label="Reserve">
            <h2 className="text-lg font-semibold">3 · Set aside USDC to manage it</h2>
            <p className="text-sm text-muted">
              A USDC reserve with Circle Gateway and standing orders: when the margin runs low, the keeper draws on it and repays.
              It protects all your positions, the one closest to liquidation first.
            </p>
            {props.signer ? <ProtectionPanel signer={props.signer} account={account} /> : <p className="text-sm text-muted">Reading your account…</p>}
          </section>
        </>
      ) : wallet && deployment ? (
        <section className="card flex flex-col gap-3" aria-label="Activate your account">
          <h2 className="text-lg font-semibold">Activate your account</h2>
          <AccountSetup wallet={wallet} deployment={deployment} onReady={props.onReady} />
        </section>
      ) : (
        <section className="card flex flex-col gap-3" aria-label="Connect a wallet">
          {deployment ? (
            <>
              <p className="text-sm text-muted">
                Connect a browser wallet (MetaMask or any EIP-1193 wallet) holding cirBTC on {network.arc.label}
                {passkeysEnabled ? ", or a passkey that owns a Circle smart account: no extension, no seed phrase." : "."}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={props.onConnect} className="btn-primary px-4 py-2 text-sm">
                  Connect wallet
                </button>
                {passkeysEnabled && (
                  <>
                    <button type="button" onClick={() => props.onPasskey("login", "")} className="btn-secondary px-4 py-2 text-sm">
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
                      <button type="submit" disabled={!username.trim()} className="btn-secondary px-4 py-2 text-sm">
                        Create
                      </button>
                    </form>
                  </>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-faint">The contracts are deployed on Arc mainnet only.</p>
          )}
        </section>
      )}
    </div>
  );
}
