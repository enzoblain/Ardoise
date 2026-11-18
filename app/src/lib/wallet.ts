import { createWalletClient, custom, numberToHex, type Account, type Address, type Chain, type EIP1193Provider, type Hex, type Transport, type TypedDataDefinition, type WalletClient } from "viem";
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

/** A passkey's Circle smart account (MSCA) on one chain, driven through Circle's bundler. */
export interface PasskeyAccount {
  /** The account's address; Circle derives the same one on every chain for a passkey. */
  address: Address;
  /**
   * Signs the calls as one user operation and hands it to Circle's bundler.
   *
   * @returns The user operation's hash.
   * @throws If the user cancels the passkey prompt, or the bundler refuses
   *   the operation (for example because it would revert): nothing was sent.
   */
  submit(calls: Call[]): Promise<Hex>;
  /**
   * Waits until a submitted user operation is mined.
   *
   * @param userOpHash Hash returned by `submit`.
   * @returns Whether the operation succeeded, and the transaction that carried it.
   * @throws If the receipt cannot be read in time; the operation may still be mined.
   */
  confirm(userOpHash: Hex): Promise<{ success: boolean; transactionHash: Hex }>;
  /**
   * Signs EIP-712 typed data with the passkey, in the form the account's
   * ERC-1271 `isValidSignature` accepts on this chain.
   *
   * @throws If the user cancels the passkey prompt.
   */
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

/**
 * A Circle smart account owned by a passkey (lib/passkey.ts) on Arc: several
 * calls go in one user operation, signed with a single passkey prompt.
 */
export interface PasskeyWallet extends PasskeyAccount {
  kind: "passkey";
  /** The passkey's name, shown in the header; unknown after signing in with an existing passkey. */
  username?: string;
  /**
   * The same passkey's smart account on Base, the source chain of the Gateway
   * reserve. Its first user operation there deploys it.
   *
   * @throws If Circle derives a different address on Base, which the keeper's
   *   checks (signer = account owner) would refuse.
   */
  onBase(): Promise<PasskeyAccount>;
}

/** The connected wallet. */
export type ConnectedWallet = BrowserWallet | PasskeyWallet;

/**
 * Sends calls from a passkey account in one user operation and waits for it.
 *
 * @returns The hash of the transaction that carried it.
 * @throws If the operation is refused, cannot be confirmed, or reverts.
 */
export async function sendFromPasskey(wallet: PasskeyAccount, calls: Call[]): Promise<Hex> {
  const userOpHash = await wallet.submit(calls);
  const { success, transactionHash } = await wallet.confirm(userOpHash);
  if (!success) throw new Error(`User operation ${userOpHash} reverted (transaction ${transactionHash})`);
  return transactionHash;
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
