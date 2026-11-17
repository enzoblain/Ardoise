import { createWalletClient, custom, numberToHex, type Account, type Address, type Chain, type EIP1193Provider, type Transport, type WalletClient } from "viem";
import { network } from "@/lib/network";

/** The connected wallet. */
export interface ConnectedWallet {
  address: Address;
  client: WalletClient<Transport, Chain, Account>;
  provider: EIP1193Provider;
}

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
export async function connectWallet(): Promise<ConnectedWallet> {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("No browser wallet found. Install MetaMask, or use the demo account.");
  const chain = network.arc.chain;
  const chainId = numberToHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch {
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
  const [address] = await provider.request({ method: "eth_requestAccounts" });
  if (!address) throw new Error("The wallet shared no account.");
  const client = createWalletClient({ account: address, chain, transport: custom(provider) });
  return { address, client, provider };
}
