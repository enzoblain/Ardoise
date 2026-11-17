import { getAddress, isHex, type Address, type Hex } from "viem";

/**
 * Deleveraging from a Circle Gateway balance (task B4 in docs/roadmap.md).
 *
 * A user keeps USDC in Circle Gateway on another chain (Base) and signs, in
 * advance, standing orders: Gateway burn intents that move a fixed amount of
 * that balance to their own Ardoise account on Arc. When a position falls
 * under the guard's minimum and the account has nothing to repay with, the
 * keeper submits enough orders to Gateway with Circle's forwarder; the USDC
 * is minted on the account and the keeper's usual `sweep()` repays the debt.
 *
 * The keeper never holds a key that can move user funds. An order can only
 * pay the account named in it, which can only repay the owner's debt, so
 * even a leaked order can do nothing but repay that debt. The keeper checks
 * this before submitting; Gateway checks the signature.
 *
 * API reference: https://developers.circle.com/gateway
 */

/** Gateway contracts and API for one environment. */
export interface GatewayNetwork {
  apiUrl: string;
  /** GatewayWallet, at the same address on every EVM chain. */
  walletContract: Address;
  /** GatewayMinter, at the same address on every EVM chain. */
  minterContract: Address;
  /** Gateway domain of Arc, where orders must deliver. */
  arcDomain: number;
  arcUsdc: Address;
  /** USDC on each source chain orders may draw from, by Gateway domain. */
  sourceUsdc: Readonly<Record<number, Address>>;
}

/** Arc and Base mainnet (addresses from Circle's Gateway contract reference and `/v1/info`). */
export const GATEWAY_MAINNET: GatewayNetwork = {
  apiUrl: "https://gateway-api.circle.com",
  walletContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
  minterContract: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
  arcDomain: 26,
  arcUsdc: "0x3600000000000000000000000000000000000000",
  sourceUsdc: { 6: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
};

/** Arc Testnet and Base Sepolia, for trying the flow without real funds. */
export const GATEWAY_TESTNET: GatewayNetwork = {
  apiUrl: "https://gateway-api-testnet.circle.com",
  walletContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  minterContract: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  arcDomain: 26,
  arcUsdc: "0x3600000000000000000000000000000000000000",
  sourceUsdc: { 6: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};

/** Gateway `TransferSpec`. Addresses are bytes32; amounts are decimal strings in USDC base units. */
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

/** Gateway `BurnIntent`: the message the depositor signs (EIP-712, see `BURN_INTENT_TYPES`). */
export interface BurnIntent {
  /** Last source-chain block at which Gateway accepts the intent. */
  maxBlockHeight: string;
  /** Highest Gateway fee, forwarding included, in USDC base units. */
  maxFee: string;
  spec: TransferSpec;
}

/** A signed burn intent, in the shape Gateway's `/v1/transfer` takes. */
export interface StandingOrder {
  burnIntent: BurnIntent;
  signature: Hex;
}

/**
 * EIP-712 domain and types of a burn intent, for wallets that sign orders.
 * The domain has no chain id or verifying contract: Gateway verifies the
 * signature itself, for whichever source chain the spec names.
 */
export const BURN_INTENT_DOMAIN = { name: "GatewayWallet", version: "1" } as const;
export const BURN_INTENT_TYPES = {
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
} as const;

/**
 * Reads standing orders from untrusted JSON (a file the operator fills).
 *
 * @param json Parsed JSON: an array of `{ burnIntent, signature }`.
 * @returns The orders.
 * @throws Error naming the first malformed entry.
 */
export function parseOrders(json: unknown): StandingOrder[] {
  if (!Array.isArray(json)) throw new Error("standing orders must be a JSON array");
  return json.map((entry, index) => {
    const order = entry as Partial<StandingOrder> | null;
    const spec = order?.burnIntent?.spec;
    const fields: (keyof TransferSpec)[] = [
      "sourceContract",
      "destinationContract",
      "sourceToken",
      "destinationToken",
      "sourceDepositor",
      "destinationRecipient",
      "sourceSigner",
      "destinationCaller",
      "salt",
      "hookData",
    ];
    const valid =
      order !== null &&
      isHex(order.signature) &&
      spec !== undefined &&
      fields.every((field) => isHex(spec[field])) &&
      [spec.version, spec.sourceDomain, spec.destinationDomain].every(Number.isInteger) &&
      [spec.value, order.burnIntent?.maxBlockHeight, order.burnIntent?.maxFee].every(
        (value) => typeof value === "string" && /^\d+$/.test(value),
      );
    if (!valid) throw new Error(`standing order ${index} is malformed`);
    return order as StandingOrder;
  });
}

/**
 * Address held in a bytes32 field, or `null` if the upper 12 bytes are not
 * zero. Gateway also accepts plain 20-byte addresses, so both are handled.
 */
function addressOf(field: Hex): Address | null {
  const digits = field.slice(2);
  if (digits.length === 40) return getAddress(field);
  if (digits.length !== 64 || !/^0{24}/.test(digits)) return null;
  return getAddress(`0x${digits.slice(24)}`);
}

function same(field: Hex, expected: Address): boolean {
  const address = addressOf(field);
  return address !== null && address === getAddress(expected);
}

/**
 * Tells why an order must not be submitted for an account, if it must not.
 *
 * The keeper only relays orders that move the owner's own Gateway balance to
 * the owner's own Ardoise account on Arc, through the official contracts and
 * tokens, with no hook and no restriction on who completes the mint (the
 * forwarder must be able to).
 *
 * @param order Order to check.
 * @param owner Owner of the Ardoise account, the expected depositor.
 * @param account Ardoise account, the expected recipient on Arc.
 * @param network Gateway environment.
 * @returns `null` if the order may be submitted, otherwise the reason.
 */
export function rejectReason(
  order: StandingOrder,
  owner: Address,
  account: Address,
  network: GatewayNetwork,
): string | null {
  const spec = order.burnIntent.spec;
  const sourceUsdc = network.sourceUsdc[spec.sourceDomain];
  if (spec.version !== 1) return `unsupported spec version ${spec.version}`;
  if (sourceUsdc === undefined) return `source domain ${spec.sourceDomain} is not supported`;
  if (spec.destinationDomain !== network.arcDomain) return `destination domain ${spec.destinationDomain} is not Arc`;
  if (!same(spec.destinationRecipient, account)) return "recipient is not the Ardoise account";
  if (!same(spec.sourceDepositor, owner)) return "depositor is not the account owner";
  if (!same(spec.sourceContract, network.walletContract)) return "source contract is not GatewayWallet";
  if (!same(spec.destinationContract, network.minterContract)) return "destination contract is not GatewayMinter";
  if (!same(spec.sourceToken, sourceUsdc)) return "source token is not USDC";
  if (!same(spec.destinationToken, network.arcUsdc)) return "destination token is not USDC on Arc";
  if (addressOf(spec.destinationCaller) !== getAddress("0x0000000000000000000000000000000000000000")) {
    return "destination caller is restricted, the forwarder could not mint";
  }
  if (spec.hookData !== "0x") return "orders with hook data are not relayed";
  if (BigInt(spec.value) === 0n) return "value is zero";
  return null;
}

/**
 * Picks the fewest orders that together cover `shortfall`, largest first.
 * When all of them together fall short, returns them all: a partial
 * repayment still raises the margin.
 *
 * @param orders Usable orders for one account.
 * @param shortfall USDC missing, in base units.
 * @returns The orders to submit; empty when `shortfall` is 0.
 */
export function selectOrders(orders: readonly StandingOrder[], shortfall: bigint): StandingOrder[] {
  if (shortfall <= 0n) return [];
  const byValue = [...orders].sort((a, b) => {
    const diff = BigInt(b.burnIntent.spec.value) - BigInt(a.burnIntent.spec.value);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  const picked: StandingOrder[] = [];
  let covered = 0n;
  for (const order of byValue) {
    if (covered >= shortfall) break;
    picked.push(order);
    covered += BigInt(order.burnIntent.spec.value);
  }
  return picked;
}

/** Terminal and intermediate statuses of a Gateway transfer. */
export type TransferStatus = { state: "pending" } | { state: "delivered"; txHash?: Hex } | { state: "failed"; reason: string };

/** Minimal `fetch`, replaceable in tests. */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Submits an order to Gateway with Circle's forwarder, which mints on Arc.
 *
 * @param order Order to submit.
 * @param network Gateway environment.
 * @param fetchImpl HTTP client.
 * @returns The Gateway transfer id.
 * @throws If Gateway refuses the order (bad signature, balance too low,
 *   expired, salt already used); the message is Gateway's.
 */
export async function submitOrder(order: StandingOrder, network: GatewayNetwork, fetchImpl: Fetch): Promise<string> {
  const res = await fetchImpl(`${network.apiUrl}/v1/transfer?enableForwarder=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([order]),
  });
  const body = (await res.json().catch(() => null)) as { transferId?: string; message?: string; error?: string } | null;
  if (!res.ok || typeof body?.transferId !== "string") {
    throw new Error(`Gateway refused the order (${res.status}): ${body?.message ?? body?.error ?? "no transfer id"}`);
  }
  return body.transferId;
}

/**
 * Reads where a Gateway transfer stands.
 *
 * @param transferId Id returned by `submitOrder`.
 * @param network Gateway environment.
 * @param fetchImpl HTTP client.
 * @returns `delivered` once minted on Arc, `failed` if it never will be,
 *   `pending` otherwise.
 * @throws If Gateway cannot be reached.
 */
export async function transferStatus(transferId: string, network: GatewayNetwork, fetchImpl: Fetch): Promise<TransferStatus> {
  const res = await fetchImpl(`${network.apiUrl}/v1/transfer/${transferId}`);
  if (!res.ok) throw new Error(`Gateway status request failed (${res.status})`);
  const body = (await res.json()) as {
    status?: string;
    transactionHash?: string;
    forwardingDetails?: { failureReason?: string };
  };
  switch (body.status) {
    case "confirmed":
    case "finalized":
      return { state: "delivered", txHash: isHex(body.transactionHash) ? body.transactionHash : undefined };
    case "failed":
      return { state: "failed", reason: body.forwardingDetails?.failureReason ?? "failed" };
    case "expired":
      return { state: "failed", reason: "the attestation expired before the forwarder minted" };
    default:
      return { state: "pending" };
  }
}

/** What the funder needs. */
export interface GatewayFunderOptions {
  network: GatewayNetwork;
  /** Reads the current standing orders; called on every funding attempt so new orders apply without a restart. */
  loadOrders: () => Promise<StandingOrder[]>;
  log: (message: string) => void;
  /** When true, logs what it would submit and submits nothing (the keeper's dry run). */
  dryRun: boolean;
  fetch?: Fetch;
}

/**
 * Submits standing orders for accounts that lack USDC to restore their
 * margin, and follows the resulting transfers.
 *
 * It keeps in memory which orders it already submitted: an order can only be
 * used once (Gateway rejects a reused salt), and while a transfer is on its
 * way the account must not be funded twice for the same shortfall.
 */
export class GatewayFunder {
  private readonly inFlight = new Map<Address, { transferId: string; salt: Hex; value: bigint }[]>();
  private readonly used = new Set<Hex>();
  private readonly lastLogged = new Map<string, string>();
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: GatewayFunderOptions) {
    this.fetchImpl = options.fetch ?? (fetch as unknown as Fetch);
  }

  /**
   * Called on every keeper pass for every account. Follows the transfers
   * already sent for the account; if none is on its way and `shortfall` is
   * positive, submits the fewest unused orders that cover it.
   *
   * @param owner Owner of the account.
   * @param account Ardoise account.
   * @param shortfall USDC missing to bring the account back to the target, as `decide()` reports it.
   */
  async fund(owner: Address, account: Address, shortfall: bigint): Promise<void> {
    if (await this.follow(account)) return;
    if (shortfall <= 0n) return;

    let orders: StandingOrder[];
    try {
      orders = await this.options.loadOrders();
    } catch (error) {
      this.logOnce(account, `cannot read standing orders: ${(error as Error).message}`);
      return;
    }
    const usable = orders.filter((order) => {
      if (this.used.has(order.burnIntent.spec.salt)) return false;
      const spec = order.burnIntent.spec;
      // Orders of other accounts are expected in a shared file; skip them quietly.
      if (!same(spec.destinationRecipient, account)) return false;
      const reason = rejectReason(order, owner, account, this.options.network);
      if (reason !== null) this.logOnce(`${account}:${spec.salt}`, `standing order ${spec.salt} ignored: ${reason}`);
      return reason === null;
    });
    const picked = selectOrders(usable, shortfall);
    if (picked.length === 0) {
      this.logOnce(account, `${usdc(shortfall)} missing and no standing order left on Gateway`);
      return;
    }

    const total = picked.reduce((sum, order) => sum + BigInt(order.burnIntent.spec.value), 0n);
    if (this.options.dryRun) {
      this.logOnce(account, `would draw ${usdc(total)} from Gateway (${picked.length} order(s)); dry run, nothing submitted`);
      return;
    }
    const sent: { transferId: string; salt: Hex; value: bigint }[] = [];
    for (const order of picked) {
      const { salt, value } = order.burnIntent.spec;
      // Marked used before the request: if Gateway accepted it but the
      // answer is lost, resubmitting would only be refused.
      this.used.add(salt);
      try {
        const transferId = await submitOrder(order, this.options.network, this.fetchImpl);
        sent.push({ transferId, salt, value: BigInt(value) });
        this.options.log(`account ${account}: drawing ${usdc(BigInt(value))} from Gateway, transfer ${transferId}`);
      } catch (error) {
        this.options.log(`account ${account}: standing order ${salt} not used: ${(error as Error).message}`);
      }
    }
    if (sent.length > 0) this.inFlight.set(account, sent);
  }

  /** Follows the account's transfers; returns true while one is still on its way. */
  private async follow(account: Address): Promise<boolean> {
    const transfers = this.inFlight.get(account);
    if (transfers === undefined) return false;
    const remaining: typeof transfers = [];
    for (const transfer of transfers) {
      let status: TransferStatus;
      try {
        status = await transferStatus(transfer.transferId, this.options.network, this.fetchImpl);
      } catch (error) {
        this.logOnce(account, `cannot read Gateway transfer ${transfer.transferId}: ${(error as Error).message}`);
        remaining.push(transfer);
        continue;
      }
      if (status.state === "pending") {
        remaining.push(transfer);
      } else if (status.state === "delivered") {
        const where = status.txHash ? ` in ${status.txHash}` : "";
        this.options.log(`account ${account}: ${usdc(transfer.value)} from Gateway delivered on Arc${where}`);
      } else {
        this.options.log(`account ${account}: Gateway transfer ${transfer.transferId} failed: ${status.reason}`);
      }
    }
    if (remaining.length === 0) this.inFlight.delete(account);
    else this.inFlight.set(account, remaining);
    return remaining.length > 0;
  }

  private logOnce(key: string, message: string): void {
    if (this.lastLogged.get(key) === message) return;
    this.lastLogged.set(key, message);
    this.options.log(`account ${key.split(":")[0]}: ${message}`);
  }
}

function usdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}
