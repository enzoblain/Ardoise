"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { Address } from "viem";
import type { ConnectedWallet } from "@/lib/wallet";

/** The connected wallet and its Ardoise account, shared by the header and the app's sections. */
export interface WalletState {
  wallet?: ConnectedWallet;
  setWallet: (wallet: ConnectedWallet | undefined) => void;
  accountAddress?: Address;
  setAccountAddress: (account: Address | undefined) => void;
}

const WalletContext = createContext<WalletState | null>(null);

/**
 * Holds the connected wallet for everything under it, so the header can show
 * it and every section of the app reads the same one.
 *
 * @param props.children The header and the app.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<ConnectedWallet>();
  const [accountAddress, setAccountAddress] = useState<Address>();
  return (
    <WalletContext.Provider value={{ wallet, setWallet, accountAddress, setAccountAddress }}>{children}</WalletContext.Provider>
  );
}

/** The shared wallet state, or `null` outside a `WalletProvider` (the landing page). */
export function useWalletState(): WalletState | null {
  return useContext(WalletContext);
}
