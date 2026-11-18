import {
  WebAuthnMode,
  getUserOperationGasPrice,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient, type Chain, type Hex, type Transport, type TypedDataDefinition } from "viem";
import { createBundlerClient, toWebAuthnAccount, type SmartAccount, type WebAuthnAccount } from "viem/account-abstraction";
import { network } from "@/lib/network";
import type { Call, PasskeyAccount, PasskeyWallet } from "@/lib/wallet";

const DEFAULT_CLIENT_URL = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";

/**
 * Creates a passkey (`register`) or signs in with an existing one (`login`),
 * and returns the Circle smart account (MSCA) it owns on the app's Arc network,
 * plus the same account on Base for the Gateway reserve.
 *
 * The account is counterfactual until its first user operation, which deploys
 * it. On Arc mainnet it pays its own gas in USDC, so it needs a small USDC
 * balance; Circle's paymaster is used on Arc Testnet, where the contracts are
 * not deployed yet (test 0.2 checked it there with a plain transfer).
 *
 * @param mode `register` for a new passkey, `login` to pick an existing one.
 * @param username Name of the new passkey; ignored on `login`.
 * @returns The connected passkey wallet.
 * @throws If no client key is configured, the browser has no passkey support,
 *   or the user cancels the prompt.
 */
export async function connectPasskey(mode: "register" | "login", username: string): Promise<PasskeyWallet> {
  const clientKey = process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY;
  if (!clientKey) throw new Error("Passkeys are not configured: set NEXT_PUBLIC_CIRCLE_CLIENT_KEY.");
  const clientUrl = process.env.NEXT_PUBLIC_CIRCLE_CLIENT_URL || DEFAULT_CLIENT_URL;

  // The SDK is built against its own copy of viem; its objects work with the
  // app's viem at runtime, but their types come from two declarations of the
  // same package, hence the casts below.
  let credential: Awaited<ReturnType<typeof toWebAuthnCredential>>;
  try {
    credential = await toWebAuthnCredential({
      transport: toPasskeyTransport(clientUrl, clientKey) as never,
      mode: mode === "register" ? WebAuthnMode.Register : WebAuthnMode.Login,
      username: mode === "register" ? username : undefined,
    });
  } catch (error) {
    // Circle answers a key that is wrong, or not registered for this domain,
    // with a bare 401 that viem reports as "An unknown RPC error occurred".
    if (error instanceof Error && error.name !== "NotAllowedError" && /RPC|401/.test(error.message)) {
      throw new Error(`Circle refused the passkey request: check the client key and that ${window.location.hostname} is its passkey domain.`);
    }
    throw error;
  }
  const owner = toWebAuthnAccount({ credential: credential as never });
  const arc = await passkeyAccount(owner, network.arc.chain, network.name === "mainnet" ? "arc" : "arcTestnet", clientUrl, clientKey);
  let base: Promise<PasskeyAccount> | undefined;

  return {
    kind: "passkey",
    ...arc,
    // Circle's sign-in returns no name for an existing passkey.
    username: mode === "register" ? username : undefined,
    onBase() {
      base ??= passkeyAccount(owner, network.base.chain, network.name === "mainnet" ? "base" : "baseSepolia", clientUrl, clientKey).then(
        (account) => {
          if (account.address.toLowerCase() !== arc.address.toLowerCase()) {
            throw new Error(`Circle derived another address on ${network.base.label} (${account.address}); Gateway orders need the same one.`);
          }
          return account;
        },
      );
      base.catch(() => (base = undefined));
      return base;
    },
  };
}

/**
 * The passkey's Circle smart account on one chain, with Circle's bundler.
 *
 * Gas: Circle's paymaster on testnets; on mainnets the account pays its own
 * gas (USDC on Arc, ETH on Base), since Circle offers no paymaster there.
 *
 * @param owner The passkey, as a viem WebAuthn account.
 * @param chain Chain of the account.
 * @param chainPath Circle's path segment for the chain: the lowerCamelCase viem chain name.
 * @param clientUrl Circle's Modular Wallets URL.
 * @param clientKey Circle client key.
 * @returns The account.
 */
async function passkeyAccount(
  owner: WebAuthnAccount,
  chain: Chain,
  chainPath: string,
  clientUrl: string,
  clientKey: string,
): Promise<PasskeyAccount> {
  const modularTransport = toModularTransport(`${clientUrl}/${chainPath}`, clientKey) as unknown as Transport;
  const client = createPublicClient({ chain, transport: modularTransport });
  const account = (await toCircleSmartAccount({ client: client as never, owner: owner as never })) as unknown as SmartAccount;
  const bundler = createBundlerClient({
    account,
    chain,
    transport: modularTransport,
    paymaster: network.name === "testnet" ? true : undefined,
    userOperation: {
      // Circle's bundler prices user operations itself; viem's default
      // estimate (from eth_maxPriorityFeePerGas) is rejected as too low.
      async estimateFeesPerGas({ bundlerClient }) {
        const { medium } = await getUserOperationGasPrice(bundlerClient as never);
        return { maxFeePerGas: BigInt(medium.maxFeePerGas), maxPriorityFeePerGas: BigInt(medium.maxPriorityFeePerGas) };
      },
    },
  });

  return {
    address: account.address,
    submit(calls: Call[]): Promise<Hex> {
      return bundler.sendUserOperation({ calls: calls.map(({ to, data }) => ({ to, data })) });
    },
    async confirm(userOpHash: Hex) {
      const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
      return { success: receipt.success, transactionHash: receipt.receipt.transactionHash };
    },
    signTypedData: (typedData: TypedDataDefinition) => account.signTypedData(typedData as never),
  };
}
