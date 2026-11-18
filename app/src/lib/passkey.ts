import {
  WebAuthnMode,
  getUserOperationGasPrice,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient, type Hex, type Transport } from "viem";
import { createBundlerClient, toWebAuthnAccount, type SmartAccount } from "viem/account-abstraction";
import { network } from "@/lib/network";
import type { Call, PasskeyWallet } from "@/lib/wallet";

const DEFAULT_CLIENT_URL = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";

/**
 * Creates a passkey (`register`) or signs in with an existing one (`login`),
 * and returns the Circle smart account (MSCA) it owns on the app's Arc network.
 *
 * The account is counterfactual until its first user operation, which deploys
 * it. Circle's paymaster sponsors gas on Arc Testnet only; on Arc mainnet the
 * account pays its own gas in USDC, so it needs a small USDC balance.
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
  const chain = network.arc.chain;
  // Circle's path segment is the lowerCamelCase viem chain name.
  const chainPath = network.name === "mainnet" ? "arc" : "arcTestnet";

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
  const modularTransport = toModularTransport(`${clientUrl}/${chainPath}`, clientKey) as unknown as Transport;
  const client = createPublicClient({ chain, transport: modularTransport });
  const account = await toCircleSmartAccount({
    client: client as never,
    owner: toWebAuthnAccount({ credential: credential as never }) as never,
  });
  const bundler = createBundlerClient({
    account: account as unknown as SmartAccount,
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
    kind: "passkey",
    address: account.address,
    username: mode === "register" ? username : (credential as { username?: string }).username || "passkey",
    async send(calls: Call[]): Promise<Hex> {
      const hash = await bundler.sendUserOperation({ calls: calls.map(({ to, data }) => ({ to, data })) });
      const receipt = await bundler.waitForUserOperationReceipt({ hash });
      if (!receipt.success) throw new Error(`User operation ${hash} reverted (transaction ${receipt.receipt.transactionHash})`);
      return receipt.receipt.transactionHash;
    },
  };
}
