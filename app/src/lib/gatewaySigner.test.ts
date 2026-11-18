import { decodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { depositAbi, gateway, sweepAbi } from "@/lib/gateway";
import { passkeyGatewaySigner } from "@/lib/gatewaySigner";
import type { Call, PasskeyAccount, PasskeyWallet } from "@/lib/wallet";

const OWNER: Address = "0x00000000000000000000000000000000000000A1";
const ACCOUNT: Address = "0x00000000000000000000000000000000000Ac0c1";
const TX: Hex = `0x${"aa".repeat(32)}`;

function fakeAccount(chain: string, log: { chain: string; calls?: Call[]; signed?: boolean }[]): PasskeyAccount {
  return {
    address: OWNER,
    async submit(calls) {
      log.push({ chain, calls });
      return `0x${"0b".repeat(32)}`;
    },
    confirm: async () => ({ success: true, transactionHash: TX }),
    async signTypedData() {
      log.push({ chain, signed: true });
      return "0x1234";
    },
  };
}

function wallet() {
  const log: { chain: string; calls?: Call[]; signed?: boolean }[] = [];
  const passkey: PasskeyWallet = { kind: "passkey", ...fakeAccount("arc", log), onBase: async () => fakeAccount("base", log) };
  return { signer: passkeyGatewaySigner(passkey), log };
}

describe("passkey Gateway signer", () => {
  it("flags its orders for ERC-1271", () => {
    expect(wallet().signer.contractSigner).toBe(true);
  });

  it("deposits on Base in one user operation: approve, then deposit", async () => {
    const { signer, log } = wallet();
    expect(await signer.deposit(5_000_000n)).toBe(TX);
    expect(log).toHaveLength(1);
    expect(log[0].chain).toBe("base");
    const [approve, deposit] = log[0].calls!;
    expect(approve.to).toBe(gateway.sourceUsdc);
    expect(decodeFunctionData({ abi: depositAbi, data: approve.data }).args).toEqual([gateway.walletContract, 5_000_000n]);
    expect(deposit.to).toBe(gateway.walletContract);
    expect(decodeFunctionData({ abi: depositAbi, data: deposit.data }).args).toEqual([gateway.sourceUsdc, 5_000_000n]);
  });

  it("signs burn intents with the Base account, whose ERC-1271 check Gateway runs on Base", async () => {
    const { signer, log } = wallet();
    await signer.signTypedData({} as never);
    expect(log).toEqual([{ chain: "base", signed: true }]);
  });

  it("sweeps from the Arc account", async () => {
    const { signer, log } = wallet();
    await signer.sweep(ACCOUNT);
    expect(log[0].chain).toBe("arc");
    expect(log[0].calls![0].to).toBe(ACCOUNT);
    expect(decodeFunctionData({ abi: sweepAbi, data: log[0].calls![0].data }).functionName).toBe("sweep");
  });
});
