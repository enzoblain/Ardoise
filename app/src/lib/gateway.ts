import {
  pad,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { network } from "@/lib/network";

/**
 * Circle Gateway from the app (B4): the user's USDC reserve on Base, the
 * standing orders they sign for the keeper, and a one-click repayment.
 * Orders follow keeper/src/gateway.ts, which checks them again before it
 * stores or submits them: an order can only pay the signer's own Ardoise
 * account on Arc.
 *
 * API reference: https://developers.circle.com/gateway
 */

/**
 * The keeper's standing-order intake; public, it holds no secret. The keeper
 * relays orders on Arc mainnet only, so it is empty elsewhere.
 */
export const KEEPER_URL = network.name === "mainnet" ? process.env.NEXT_PUBLIC_KEEPER_URL || "" : "";

/** Gateway contracts and API on the app's network. */
export const gateway = {
  apiUrl: network.name === "mainnet" ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com",
  walletContract: (network.name === "mainnet"
    ? "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
    : "0x0077777d7EBA4688BDeF3E311b846F25870A19B9") as Address,
  minterContract: (network.name === "mainnet"
    ? "0x2222222d7164433c4C09B0b0D809a9b52C04C205"
    : "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B") as Address,
  /** USDC on the source chain (Base or Base Sepolia). */
  sourceUsdc: (network.name === "mainnet"
    ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    : "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address,
  arcUsdc: "0x3600000000000000000000000000000000000000" as Address,
  sourceDomain: network.base.cctpDomain,
  arcDomain: network.arc.cctpDomain,
} as const;

/** Gateway `TransferSpec`; addresses as left-padded bytes32, amounts as decimal strings. */
export interface TransferSpec {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: Hex;
  destinationContract: Hex;
  sourceToken: Hex;
  destinationToken: Hex;
  sourceDepositor: Hex;
  destinationRecipient: Hex;
  sourceSigner: Hex;
  destinationCaller: Hex;
  value: string;
  salt: Hex;
  hookData: Hex;
}

/** A signed burn intent, as Gateway's `/v1/transfer` and the keeper take it. */
export interface StandingOrder {
  burnIntent: { maxBlockHeight: string; maxFee: string; spec: TransferSpec };
  signature: Hex;
  /** Set when the signer is a smart account: Gateway then checks the signature with ERC-1271. */
  contractSigner?: true;
}

/** Who signs burn intents: a browser wallet, or a passkey smart account (ERC-1271). */
export interface IntentSigner {
  /** Whether signatures come from a smart account, for Gateway's `contractSigner` flag. */
  contractSigner: boolean;
  /** Signs EIP-712 typed data as the depositor. */
  signTypedData(typedData: ReturnType<typeof burnIntentTypedData>): Promise<Hex>;
}

const bytes32 = (address: Address): Hex => pad(address.toLowerCase() as Address, { size: 32 });

/**
 * The transfer spec of one standing order: `value` USDC from the owner's
 * Gateway balance on Base to their Ardoise account on Arc, minted by
 * Circle's forwarder (open caller, no hook).
 *
 * @param owner Depositor and signer.
 * @param account The owner's Ardoise account, the only recipient allowed.
 * @param value Amount in USDC units (6 decimals).
 * @param salt 32 bytes that make the order unique; random by default.
 * @returns The spec.
 */
export function orderSpec(owner: Address, account: Address, value: bigint, salt?: Hex): TransferSpec {
  return {
    version: 1,
    sourceDomain: gateway.sourceDomain,
    destinationDomain: gateway.arcDomain,
    sourceContract: bytes32(gateway.walletContract),
    destinationContract: bytes32(gateway.minterContract),
    sourceToken: bytes32(gateway.sourceUsdc),
    destinationToken: bytes32(gateway.arcUsdc),
    sourceDepositor: bytes32(owner),
    destinationRecipient: bytes32(account),
    sourceSigner: bytes32(owner),
    destinationCaller: bytes32("0x0000000000000000000000000000000000000000"),
    value: value.toString(),
    salt: salt ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
    hookData: "0x",
  };
}

/**
 * EIP-712 typed data of a burn intent (domain `GatewayWallet` version 1), as
 * the depositor signs it and the keeper verifies it.
 *
 * @param intent Burn intent with decimal-string amounts.
 * @returns Arguments for `signTypedData` / `verifyTypedData`.
 */
export function burnIntentTypedData(intent: StandingOrder["burnIntent"]) {
  return {
    domain: { name: "GatewayWallet", version: "1" },
    types: {
      TransferSpec: [
        { name: "version", type: "uint32" },
        { name: "sourceDomain", type: "uint32" },
        { name: "destinationDomain", type: "uint32" },
        { name: "sourceContract", type: "bytes32" },
        { name: "destinationContract", type: "bytes32" },
        { name: "sourceToken", type: "bytes32" },
        { name: "destinationToken", type: "bytes32" },
        { name: "sourceDepositor", type: "bytes32" },
        { name: "destinationRecipient", type: "bytes32" },
        { name: "sourceSigner", type: "bytes32" },
        { name: "destinationCaller", type: "bytes32" },
        { name: "value", type: "uint256" },
        { name: "salt", type: "bytes32" },
        { name: "hookData", type: "bytes" },
      ],
      BurnIntent: [
        { name: "maxBlockHeight", type: "uint256" },
        { name: "maxFee", type: "uint256" },
        { name: "spec", type: "TransferSpec" },
      ],
    },
    primaryType: "BurnIntent",
    message: {
      maxBlockHeight: BigInt(intent.maxBlockHeight),
      maxFee: BigInt(intent.maxFee),
      spec: { ...intent.spec, value: BigInt(intent.spec.value) },
    },
  } as const;
}

async function gatewayPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${gateway.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || json === null) throw new Error(`Gateway answered ${res.status}: ${json?.message ?? "no body"}`);
  return json;
}

/**
 * The owner's Gateway balance on Base, available to orders.
 *
 * @param depositor Owner.
 * @returns USDC units (6 decimals); Gateway credits a deposit only after
 *   Base finality.
 */
export async function gatewayBalance(depositor: Address): Promise<bigint> {
  const body = await gatewayPost<{ balances: { balance: string }[] }>("/v1/balances", {
    token: "USDC",
    sources: [{ domain: gateway.sourceDomain, depositor }],
  });
  return parseUnits(body.balances[0]?.balance ?? "0", 6);
}

/**
 * Multiplier on Gateway's fee estimate used to sign every order, standing or
 * immediate: on mainnet an immediate repayment signed at the estimate was
 * refused for 0.000222 USDC of missing fee, and a standing order may be
 * submitted weeks later when the fee has moved. Gateway charges only the
 * actual fee.
 */
export const FEE_HEADROOM = 2n;

/**
 * Asks Gateway for the fee cap and validity of a spec, then has the owner
 * sign it. Signing costs no gas and needs no network switch: the EIP-712
 * domain has no chain id.
 *
 * @param signer The owner, depositor and signer of the spec.
 * @param spec Spec from `orderSpec`.
 * @param feeHeadroom Multiplier on the estimated fee cap, `FEE_HEADROOM` by
 *   default.
 * @returns The signed order, valid about 70 days on Base.
 */
export async function signOrder(
  signer: IntentSigner,
  spec: TransferSpec,
  feeHeadroom = FEE_HEADROOM,
): Promise<StandingOrder> {
  const estimate = await gatewayPost<{ body: { burnIntent: { maxBlockHeight: string; maxFee: string } }[] }>(
    "/v1/estimate?enableForwarder=true",
    [{ spec }],
  );
  const { maxBlockHeight, maxFee: estimatedFee } = estimate.body[0].burnIntent;
  const burnIntent = { maxBlockHeight, maxFee: (BigInt(estimatedFee) * feeHeadroom).toString(), spec };
  const signature = await signer.signTypedData(burnIntentTypedData(burnIntent));
  return signer.contractSigner ? { burnIntent, signature, contractSigner: true } : { burnIntent, signature };
}

/**
 * Sends standing orders to the keeper's intake, which checks and stores them.
 *
 * @param keeperUrl Base URL of the keeper intake (`NEXT_PUBLIC_KEEPER_URL`).
 * @param orders Signed orders.
 * @returns One result per order.
 * @throws If the keeper cannot be reached or refuses the request.
 */
export async function sendToKeeper(
  keeperUrl: string,
  orders: StandingOrder[],
): Promise<{ index: number; status: string; reason?: string }[]> {
  const res = await fetch(`${keeperUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(orders),
  });
  const body = (await res.json().catch(() => null)) as { results?: []; error?: string } | null;
  if (!res.ok || !body?.results) throw new Error(`Keeper answered ${res.status}: ${body?.error ?? "no results"}`);
  return body.results;
}

/** A standing order as the keeper lists it: no signature, so a listing cannot be replayed. */
export interface OrderSummary {
  value: string;
  maxBlockHeight: string;
  salt: Hex;
}

/**
 * The live standing orders the keeper holds for an owner (not expired, not used).
 *
 * @param keeperUrl Base URL of the keeper intake.
 * @param owner Depositor.
 * @returns Their summaries.
 */
export async function keeperOrders(keeperUrl: string, owner: Address): Promise<OrderSummary[]> {
  const res = await fetch(`${keeperUrl}/orders?owner=${owner}`);
  if (!res.ok) throw new Error(`Keeper answered ${res.status}`);
  return (await res.json()) as OrderSummary[];
}

/**
 * Submits one signed order to Gateway right away, with Circle's forwarder
 * minting on Arc: the one-click repayment. The USDC lands on the account,
 * where `sweep()` applies it to the debt.
 *
 * @param order Signed order.
 * @returns The Gateway transfer id.
 */
export async function submitToGateway(order: StandingOrder): Promise<string> {
  const body = await gatewayPost<{ transferId?: string }>("/v1/transfer?enableForwarder=true", [order]);
  if (!body.transferId) throw new Error("Gateway returned no transfer id");
  return body.transferId;
}

/**
 * Where a Gateway transfer stands.
 *
 * @param transferId Id from `submitToGateway`.
 * @returns `delivered` once minted on Arc, `failed` if it never will be,
 *   `pending` otherwise, including when Gateway does not answer: the
 *   transfer may still be on its way, and treating that as a failure would
 *   invite a second repayment.
 */
export async function gatewayTransfer(transferId: string): Promise<{ state: "pending" | "delivered" | "failed"; txHash?: Hex }> {
  const res = await fetch(`${gateway.apiUrl}/v1/transfer/${transferId}`).catch(() => null);
  if (res === null || !res.ok) return { state: "pending" };
  const body = (await res.json().catch(() => ({}))) as { status?: string; transactionHash?: Hex };
  if (body.status === "confirmed" || body.status === "finalized") return { state: "delivered", txHash: body.transactionHash };
  if (body.status === "failed" || body.status === "expired") return { state: "failed" };
  return { state: "pending" };
}

/** GatewayWallet's deposit and the USDC approval it needs, on the source chain. */
export const depositAbi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function deposit(address token, uint256 value)",
]);

/** `IArdoise.sweep()`: applies the USDC on the account to its debt; anyone may call it. */
export const sweepAbi = parseAbi(["function sweep() returns (uint256 repaid)"]);
