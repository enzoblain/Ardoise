"use client";

import Link from "next/link";
import { useWalletState } from "@/lib/walletContext";

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The header's wallet button: "Connect wallet" until a wallet is connected,
 * then that wallet's address (and passkey name), which disconnects on click.
 */
export function HeaderWallet() {
  const state = useWalletState();
  const wallet = state?.wallet;
  if (!state || !wallet) {
    return (
      <Link
        href="/app?connect=wallet"
        className="rounded-full bg-[#fafafa] px-4 py-2 font-medium text-[#0a0a0a] transition-opacity hover:opacity-85"
      >
        Connect wallet
      </Link>
    );
  }
  return (
    <button
      type="button"
      title="Disconnect"
      onClick={() => {
        state.setWallet(undefined);
        state.setAccountAddress(undefined);
      }}
      className="group inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 font-mono text-sm text-foreground transition-colors hover:border-line-strong"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
      {wallet.kind === "passkey" && wallet.username ? `${wallet.username} · ` : ""}
      {short(wallet.address)}
      <span className="hidden text-xs text-muted group-hover:inline">· disconnect</span>
    </button>
  );
}
