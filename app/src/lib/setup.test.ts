import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { factoryAbi } from "@/lib/contracts/abis";
import { aaveSpokeAbi, aaveTakerAbi, erc20Abi, MAINNET_DEPLOYMENT as deployment } from "@/lib/contracts/deployments";
import { activationCalls, missingSteps, type SetupState } from "@/lib/setup";

const ready: SetupState = {
  collateral: 6_270n,
  walletCirBtc: 0n,
  collateralEnabled: true,
  takerApproved: true,
  giverApproved: true,
  account: "0x00000000000000000000000000000000000Ac0c1",
  borrowAllowance: 60_000_000n,
  perPaymentCap: 10_000_000n,
};

describe("missingSteps", () => {
  it("is empty once every step is done", () => {
    expect(missingSteps(ready)).toEqual([]);
  });

  it("lists the missing steps in the order to run them", () => {
    expect(
      missingSteps({ ...ready, takerApproved: false, giverApproved: false, account: null, borrowAllowance: 0n }),
    ).toEqual(["approveTaker", "approveGiver", "createAccount", "approveBorrow"]);
  });

  it("asks to renew the allowance once it no longer covers a full payment", () => {
    expect(missingSteps({ ...ready, borrowAllowance: 3_000_000n })).toEqual(["approveBorrow"]);
    expect(missingSteps({ ...ready, borrowAllowance: 10_000_000n })).toEqual([]);
  });
});

describe("activationCalls", () => {
  const OWNER = "0x00000000000000000000000000000000000000A1";
  const fresh: SetupState = {
    ...ready,
    collateral: 0n,
    walletCirBtc: 5_000n,
    collateralEnabled: false,
    takerApproved: false,
    giverApproved: false,
    account: null,
    borrowAllowance: 0n,
  };
  const ABIS = [erc20Abi, aaveSpokeAbi, factoryAbi, aaveTakerAbi] as const;
  const decode = (data: `0x${string}`) => {
    for (const abi of ABIS) {
      try {
        return decodeFunctionData({ abi, data });
      } catch {
        // Not this contract's function: try the next ABI.
      }
    }
    throw new Error(`unknown call ${data.slice(0, 10)}`);
  };

  it("is empty once the account is ready", () => {
    expect(activationCalls(ready, deployment, OWNER, 60_000_000n)).toEqual([]);
  });

  it("supplies the held cirBTC, enables it, then runs every missing step, in one batch", () => {
    const calls = activationCalls(fresh, deployment, OWNER, 60_000_000n);
    expect(calls.map((call) => call.to)).toEqual([
      deployment.cirBtc,
      deployment.aaveSpoke,
      deployment.aaveSpoke,
      deployment.aaveSpoke,
      deployment.aaveSpoke,
      deployment.factory,
      deployment.aaveTaker,
    ]);
    const decoded = calls.map((call) => decode(call.data));
    expect(decoded.map((call) => call.functionName)).toEqual([
      "approve",
      "supply",
      "setUsingAsCollateral",
      "setUserPositionManager",
      "setUserPositionManager",
      "createAccount",
      "approveBorrow",
    ]);
    expect(decoded[0].args).toEqual([deployment.aaveSpoke, 5_000n]);
    expect(decoded[1].args).toEqual([deployment.cirBtcReserveId, 5_000n, OWNER]);
    expect(decoded[2].args).toEqual([deployment.cirBtcReserveId, true, OWNER]);
    expect(decoded[6].args).toEqual([deployment.aaveSpoke, deployment.usdcReserveId, deployment.aaveAdapter, 60_000_000n]);
  });

  it("only tops up the collateral when the rest is done", () => {
    const calls = activationCalls({ ...ready, walletCirBtc: 1_000n }, deployment, OWNER, 60_000_000n);
    expect(calls.map((call) => decode(call.data).functionName)).toEqual(["approve", "supply"]);
  });

  it("does not enable a collateral it has none of", () => {
    const calls = activationCalls({ ...fresh, walletCirBtc: 0n }, deployment, OWNER, 60_000_000n);
    expect(calls.map((call) => decode(call.data).functionName)).not.toContain("setUsingAsCollateral");
  });
});
