import { createWalletClient, custom, numberToHex, type Account, type Address, type Chain, type EIP1193Provider, type Hex, type Transport, type WalletClient } from "viem";
import { network } from "@/lib/network";

/** One contract call, as a smart account batches it. */
export interface Call {
  to: Address;
  data: Hex;
}

/** A browser wallet (MetaMask or any injected EIP-1193 wallet): one transaction per call. */
export interface BrowserWallet {
  kind: "browser";
  address: Address;
  client: WalletClient<Transport, Chain, Account>;
  provider: EIP1193Provider;
}

/**
 * A Circle smart account owned by a passkey (lib/passkey.ts): several calls
 * go in one user operation, signed with a single passkey prompt.
 */
export interface PasskeyWallet {
  kind: "passkey";
  /** The smart account's address, which holds the collateral and owns the Ardoise account. */
  address: Address;
  /** The passkey's name, shown in the header. */
  username: string;
  /**
   * Sends the calls in one user operation and waits for it.
   *
   * @returns The hash of the Arc transaction that carried it.
   * @throws If the user cancels the passkey prompt, or the operation fails.
   */
  send(calls: Call[]): Promise<Hex>;
}

/** The connected wallet. */
export type ConnectedWallet = BrowserWallet | PasskeyWallet;

/**
 * Connects the browser wallet (MetaMask or any injected EIP-1193 wallet) on
 * the app's Arc network, adding the network to the wallet if needed.
 *
 * Wallets grant access per network, so access is requested once Arc is
 * selected.
 *
 * @returns The connected wallet.
 * @throws If there is no browser wallet, or the user refuses.
 */
export async function connectWallet(): Promise<BrowserWallet> {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("No browser wallet found. Install MetaMask, or use the demo account.");
  const chain = network.arc.chain;
  await switchChain(provider, chain);
  const [address] = await provider.request({ method: "eth_requestAccounts" });
  if (!address) throw new Error("The wallet shared no account.");
  const client = createWalletClient({ account: address, chain, transport: custom(provider) });
  return { kind: "browser", address, client, provider };
}

/**
 * Switches the browser wallet to `chain`, adding it first if the wallet does
 * not know it yet.
 *
 * @param provider Browser wallet.
 * @param chain Chain to select.
 * @throws If the user refuses the switch or the addition.
 */
export async function switchChain(provider: EIP1193Provider, chain: Chain): Promise<void> {
  const chainId = numberToHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    // 4902: the wallet does not know the chain yet. Anything else (the user
    // refusing the switch, 4001) must not turn into an "add network" prompt.
    // Some MetaMask mobile versions wrap it in a -32603 error.
    const wrapped = error as { code?: number; data?: { originalError?: { code?: number } } };
    if (wrapped.code !== 4902 && wrapped.data?.originalError?.code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}
