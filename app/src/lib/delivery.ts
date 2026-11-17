import { createPublicClient, formatUnits, http, isHash, type Hex } from "viem";
import { chainByDomain, network, type PayoutChain } from "@/lib/network";

/** Where a cross-chain payment stands. */
export type DeliveryStage =
  /** Iris has not indexed the burn yet (or the hash is not a CCTP burn). */
  | "not_found"
  /** The burn is indexed; Circle has not signed the attestation yet. */
  | "attesting"
  /** Attested; waiting for the mint on the destination chain. */
  | "delivering"
  | "delivered"
  /** Circle's forwarder could not submit the mint. */
  | "failed";

/** Delivery status of one cross-chain payment, as read from Iris. */
export interface Delivery {
  stage: DeliveryStage;
  sourceTxHash: Hex;
  destinationDomain?: number;
  recipient?: Hex;
  /** USDC burned on the source chain, as a decimal string. */
  amount?: string;
  /** USDC kept by CCTP as the fast-transfer and forwarding fee. */
  fee?: string;
  /** USDC the recipient receives (amount minus fee). */
  received?: string;
  mintTxHash?: Hex;
  /** Reason Iris gives when an attestation is delayed. */
  delayReason?: string;
}

interface IrisMessage {
  status?: string;
  forwardState?: string | null;
  forwardTxHash?: string | null;
  destinationMintTxHash?: string | null;
  delayReason?: string | null;
  decodedMessage?: {
    destinationDomain?: string;
    decodedMessageBody?: {
      mintRecipient?: string;
      amount?: string;
      feeExecuted?: string;
    } | null;
  } | null;
}

const USDC_DECIMALS = 6;

/**
 * Turns an Iris `/v2/messages` response into a delivery status.
 *
 * @param sourceTxHash Hash of the burn transaction on Arc.
 * @param body Parsed JSON body returned by Iris (or `null` on a 404).
 * @returns The delivery status. Only the first message is read: an Ardoise
 *   payment burns once per transaction.
 */
export function parseIrisResponse(sourceTxHash: Hex, body: unknown): Delivery {
  const message = (body as { messages?: IrisMessage[] } | null)?.messages?.[0];
  if (!message) return { stage: "not_found", sourceTxHash };

  const decoded = message.decodedMessage;
  const payload = decoded?.decodedMessageBody;
  const amount = payload?.amount ? BigInt(payload.amount) : undefined;
  const fee = payload?.feeExecuted ? BigInt(payload.feeExecuted) : undefined;
  const mintTxHash = pickMintTx(message);

  let stage: DeliveryStage;
  if (message.forwardState === "FAILED") stage = "failed";
  else if (mintTxHash) stage = "delivered";
  else if (message.status === "complete") stage = "delivering";
  else stage = "attesting";

  return {
    stage,
    sourceTxHash,
    destinationDomain: decoded?.destinationDomain
      ? Number(decoded.destinationDomain)
      : undefined,
    recipient: payload?.mintRecipient as Hex | undefined,
    amount: amount !== undefined ? formatUnits(amount, USDC_DECIMALS) : undefined,
    fee: fee !== undefined ? formatUnits(fee, USDC_DECIMALS) : undefined,
    received:
      amount !== undefined
        ? formatUnits(amount - (fee ?? 0n), USDC_DECIMALS)
        : undefined,
    mintTxHash,
    delayReason: message.delayReason ?? undefined,
  };
}

// The forwarder reports its own transaction; without a forwarder only
// `destinationMintTxHash` is set, once someone has minted.
function pickMintTx(message: IrisMessage): Hex | undefined {
  const forwarded =
    message.forwardState === "CONFIRMED" || message.forwardState === "COMPLETE"
      ? message.forwardTxHash
      : undefined;
  const hash = message.destinationMintTxHash || forwarded;
  return hash && isHash(hash) ? hash : undefined;
}

/**
 * Reads the delivery status of a payment from Circle's Iris API.
 *
 * Iris is public and allows browser requests, so no key or server route is
 * needed.
 *
 * @param sourceTxHash Hash of the burn transaction on Arc.
 * @returns The delivery status.
 * @throws If Iris answers with an error other than 404.
 */
export async function fetchDelivery(sourceTxHash: Hex): Promise<Delivery> {
  const url = `${network.irisUrl}/v2/messages/${network.arc.cctpDomain}?transactionHash=${sourceTxHash}`;
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return parseIrisResponse(sourceTxHash, null);
  if (!res.ok) throw new Error(`Iris answered ${res.status}`);
  return parseIrisResponse(sourceTxHash, await res.json());
}

/**
 * Measures how long a delivered payment took, from the burn block on Arc to
 * the mint block on the destination chain.
 *
 * Uses block timestamps rather than the browser clock, so the figure does
 * not depend on when the page was opened.
 *
 * @param delivery A delivery in the `delivered` stage.
 * @returns Seconds between the two blocks, or `undefined` if the delivery is
 *   not complete or a chain cannot be read.
 */
export async function measureDeliverySeconds(
  delivery: Delivery,
): Promise<number | undefined> {
  const destination =
    delivery.destinationDomain !== undefined
      ? chainByDomain(delivery.destinationDomain)
      : undefined;
  if (delivery.stage !== "delivered" || !delivery.mintTxHash || !destination) {
    return undefined;
  }
  try {
    const [sent, received] = await Promise.all([
      blockTime(network.arc, delivery.sourceTxHash),
      blockTime(destination, delivery.mintTxHash),
    ]);
    return Number(received - sent);
  } catch {
    return undefined;
  }
}

async function blockTime(chain: PayoutChain, hash: Hex): Promise<bigint> {
  const client = createPublicClient({ chain: chain.chain, transport: http() });
  const receipt = await client.getTransactionReceipt({ hash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return block.timestamp;
}
