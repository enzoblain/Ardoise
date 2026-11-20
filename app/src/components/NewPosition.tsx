"use client";

import { useState, type ReactNode } from "react";
import type { Address } from "viem";
import { AccountSetup } from "@/components/AccountSetup";
import { ProtectionPanel } from "@/components/ProtectionPanel";
import type { Deployment } from "@/lib/contracts/deployments";
import type { GatewaySigner } from "@/lib/gatewaySigner";
import { network } from "@/lib/network";
import type { ConnectedWallet } from "@/lib/wallet";

// Passkeys need a Circle client key (registered for this domain); without one, only browser wallets are offered.
const passkeysEnabled = Boolean(process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY);

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** One numbered step of the page, greyed out until the steps before it are done. */
function Step(props: { n: number; title: string; done?: boolean; active: boolean; children: ReactNode }) {
  return (
    <section className={`card flex flex-col gap-3 ${props.active || props.done ? "" : "opacity-60"}`} aria-label={props.title}>
      <div className="flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs ${
            props.done ? "border-accent bg-accent text-background" : "border-line text-muted"
          }`}
        >
          {props.done ? "✓" : props.n}
        </span>
        <h2 className="text-lg font-semibold">{props.title}</h2>
      </div>
      {props.children}
    </section>
  );
}

/**
 * Opening a live position, in three steps on one page: connect a wallet
 * (browser wallet or passkey), the one-time setup on Aave V4 and the account,
 * then the protection from Base (Gateway reserve, standing orders, repaying
 * from Base). Before a wallet is connected the later steps say what they will
 * ask for, so a visitor sees the whole path.
 *
 * @param props.wallet The connected wallet, if any.
 * @param props.account The owner's Ardoise account once the setup is done.
 * @param props.deployment The contracts of the selected network, or `null` where nothing is deployed.
 * @param props.signer Signs Gateway deposits and orders for the connected wallet.
 * @param props.onConnect Connects a browser wallet.
 * @param props.onPasskey Signs in with, or creates, a passkey.
 * @param props.onReady Called with the account address once the setup is done.
 */
export function NewPosition(props: {
  wallet?: ConnectedWallet;
  account?: Address;
  deployment: Deployment | null;
  signer?: GatewaySigner;
  onConnect: () => void;
  onPasskey: (mode: "register" | "login", username: string) => void;
  onReady: (account: Address) => void;
}) {
  const { wallet, account, deployment } = props;
  const [username, setUsername] = useState("");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <p className="eyebrow">On {network.arc.label}</p>
        <h2 className="text-2xl font-semibold tracking-tight">New position</h2>
        <p className="mt-1 text-sm text-muted">
          Your cirBTC stays in your own lending position. Ardoise only gets the right to borrow USDC for your payments,
          within caps, and a guard refuses any payment that would leave less than the minimum margin.
        </p>
      </div>

      <Step n={1} title="Connect a wallet" done={wallet !== undefined} active={wallet === undefined}>
        {wallet ? (
          <p className="text-sm text-muted">
            {wallet.kind === "passkey" ? `Passkey${wallet.username ? ` “${wallet.username}”` : ""}` : "Browser wallet"}:{" "}
            <span className="font-mono text-foreground">{short(wallet.address)}</span>
          </p>
        ) : deployment ? (
          <>
            <p className="text-sm text-muted">
              A browser wallet (MetaMask or any EIP-1193 wallet) holding cirBTC on {network.arc.label}
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
      </Step>

      <Step n={2} title="Activate your account" done={account !== undefined} active={wallet !== undefined && account === undefined}>
        {wallet && deployment && !account ? (
          <AccountSetup wallet={wallet} deployment={deployment} onReady={props.onReady} />
        ) : account ? (
          <p className="text-sm text-muted">
            Ardoise account <span className="font-mono text-foreground">{short(account)}</span> is ready. Your positions
            and payments are on the My positions tab.
          </p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
            <li>cirBTC supplied as collateral on Aave V4 (in your own position).</li>
            <li>Let Aave&apos;s position managers borrow and repay on your behalf.</li>
            <li>Create your Ardoise account, one per wallet.</li>
            <li>Allow it to borrow up to a set amount of USDC. A passkey does all of this in one signature.</li>
          </ul>
        )}
      </Step>

      <Step n={3} title={`Protect it from ${network.base.label}`} active={account !== undefined}>
        {account && props.signer ? (
          <ProtectionPanel signer={props.signer} account={account} />
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
            <li>Deposit USDC into Circle Gateway on {network.base.label}: your reserve.</li>
            <li>Sign standing orders, signatures with no gas, that let the keeper bring that reserve to your account when your margin runs low.</li>
            <li>Or repay from {network.base.label} yourself, in one click, at any time.</li>
          </ul>
        )}
      </Step>
    </div>
  );
}
