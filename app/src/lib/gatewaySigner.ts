import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { arcClient } from "@/lib/arc";
import { depositAbi, gateway, sweepAbi, type IntentSigner } from "@/lib/gateway";
import { network } from "@/lib/network";
import { sendFromPasskey, switchChain, type Call, type PasskeyWallet } from "@/lib/wallet";

/**
 * What the Protection panel needs from the owner's wallet: deposit on Base,
 * sign burn intents as the depositor, and apply delivered USDC on Arc. One
 * implementation per kind of wallet, so the panel does not care which.
 */
export interface GatewaySigner extends IntentSigner {
  /** Depositor and signer on Base, and owner of the Ardoise account on Arc. */
  address: Address;
  /** Where the owner confirms each action, for the buttons' labels. */
  prompt: "wallet" | "passkey";
  /**
   * Approves and deposits USDC into the Gateway Wallet on Base, and waits for it.
   *
   * @param amount USDC units (6 decimals).
   * @returns The Base transaction of the deposit.
   */
  deposit(amount: bigint): Promise<Hex>;
  /**
   * Calls `sweep()` on the Ardoise account, so USDC delivered there repays the debt now.
   *
   * @returns The Arc transaction.
   */
  sweep(account: Address): Promise<Hex>;
  /**
   * Sends calls on Base from the owner (the defense mandate: approvals and
   * `setPolicy` on the executor) and waits for them.
   *
   * @param calls Calls in order.
   * @returns The Base transaction of the last call.
   */
  sendOnBase(calls: Call[]): Promise<Hex>;
}

/**
 * The Gateway signer of a browser wallet: two transactions on Base for a
 * deposit (the wallet switches to Base and back), plain EIP-712 signatures.
 *
 * @param provider Browser wallet.
 * @param owner Its account.
 */
export function browserGatewaySigner(provider: EIP1193Provider, owner: Address): GatewaySigner {
  return {
    address: owner,
    prompt: "wallet",
    contractSigner: false,
    signTypedData: (typedData) => createWalletClient({ account: owner, transport: custom(provider) }).signTypedData(typedData),
    async deposit(amount) {
      const chain = network.base.chain;
      await switchChain(provider, chain);
      try {
        const wallet = createWalletClient({ account: owner, chain, transport: custom(provider) });
        const base = createPublicClient({ chain, transport: http() });
        const approval = await wallet.writeContract({
          address: gateway.sourceUsdc,
          abi: depositAbi,
          functionName: "approve",
          args: [gateway.walletContract, amount],
        });
        await base.waitForTransactionReceipt({ hash: approval });
        const hash = await wallet.writeContract({
          address: gateway.walletContract,
          abi: depositAbi,
          functionName: "deposit",
          args: [gateway.sourceUsdc, amount],
        });
        const receipt = await base.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`Deposit ${hash} reverted`);
        return hash;
      } finally {
        // The rest of the app signs on Arc.
        await switchChain(provider, network.arc.chain).catch(() => undefined);
      }
    },
    async sendOnBase(calls) {
      const chain = network.base.chain;
      await switchChain(provider, chain);
      try {
        const wallet = createWalletClient({ account: owner, chain, transport: custom(provider) });
        const base = createPublicClient({ chain, transport: http() });
        let hash: Hex = "0x";
        for (const call of calls) {
          hash = await wallet.sendTransaction({ to: call.to, data: call.data });
          const receipt = await base.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
        }
        return hash;
      } finally {
        await switchChain(provider, network.arc.chain).catch(() => undefined);
      }
    },
    async sweep(account) {
      await switchChain(provider, network.arc.chain);
      const wallet = createWalletClient({ account: owner, chain: network.arc.chain, transport: custom(provider) });
      const hash = await wallet.writeContract({ address: account, abi: sweepAbi, functionName: "sweep" });
      const receipt = await arcClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
      return hash;
    },
  };
}

/**
 * The Gateway signer of a passkey: its smart account on Base deposits in one
 * user operation (approve and deposit, plus the account's deployment the first
 * time), and signs burn intents through ERC-1271, which Gateway checks on Base
 * when the order carries `contractSigner`. The account must be deployed on
 * Base for that check, which its first deposit does.
 *
 * @param wallet The passkey wallet.
 */
export function passkeyGatewaySigner(wallet: PasskeyWallet): GatewaySigner {
  return {
    address: wallet.address,
    prompt: "passkey",
    contractSigner: true,
    signTypedData: async (typedData) => (await wallet.onBase()).signTypedData(typedData),
    async deposit(amount) {
      return sendFromPasskey(await wallet.onBase(), [
        {
          to: gateway.sourceUsdc,
          data: encodeFunctionData({ abi: depositAbi, functionName: "approve", args: [gateway.walletContract, amount] }),
        },
        {
          to: gateway.walletContract,
          data: encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [gateway.sourceUsdc, amount] }),
        },
      ]);
    },
    sweep: (account) => sendFromPasskey(wallet, [{ to: account, data: encodeFunctionData({ abi: sweepAbi, functionName: "sweep" }) }]),
    sendOnBase: async (calls) => sendFromPasskey(await wallet.onBase(), calls),
  };
}
