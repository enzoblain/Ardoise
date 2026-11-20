import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { arcClient } from "@/lib/arc";
import { KEEPER_URL, gateway, gatewayBalance, keeperOrders } from "@/lib/gateway";
import { network } from "@/lib/network";
import type { ReserveAsset } from "@/lib/stress";

/**
 * Chainlink ETH / USD on Base mainnet (8 decimals), checked on chain
 * (`description()` is "ETH / USD").
 */
const ETH_USD_FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
// Older than this, the price is treated as unreadable rather than shown stale.
const MAX_PRICE_AGE_S = 3 * 3600;
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

const baseMainnet = createPublicClient({ chain: base, transport: http() });
const baseClient = network.name === "mainnet" ? baseMainnet : createPublicClient({ chain: network.base.chain, transport: http() });

/**
 * Reads the ETH price in USD.
 *
 * @returns The price, from Chainlink on Base.
 * @throws If Base cannot be read.
 */
export async function ethPriceUsd(): Promise<number> {
  const [, answer, , updatedAt] = await baseMainnet.readContract({ address: ETH_USD_FEED, abi: feedAbi, functionName: "latestRoundData" });
  if (answer <= 0n) throw new Error("the ETH / USD feed returned no price");
  if (Date.now() / 1000 - Number(updatedAt) > MAX_PRICE_AGE_S) throw new Error("the ETH / USD price is stale");
  return Number(formatUnits(answer, 8));
}

/** The reserve read, with what could not be read. */
export interface ReserveRead {
  assets: ReserveAsset[];
  /** One short message per source that failed. */
  errors: string[];
}

/**
 * Reads what the owner holds that can defend the position: USDC waiting on
 * the Ardoise account (repaid by the keeper's `sweep()` at once), the Gateway
 * reserve on Base (the keeper draws only the part its unspent standing
 * orders cover; the rest needs the owner), and USDC and ETH in the owner's
 * wallet on Base (the owner would deposit or swap them by hand). ETH is left
 * out on testnet, where it has no value. Each source is read on its own: one
 * that fails is reported and left out.
 *
 * @param owner The owner's wallet, the same address on Arc and Base.
 * @param account The owner's Ardoise account on Arc.
 * @returns The non-empty reserve assets and the read errors.
 */
export async function readReserve(owner: Address, account: Address): Promise<ReserveRead> {
  const usdcOf = (client: typeof arcClient | typeof baseClient, token: Address, holder: Address) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const sources: [string, Promise<ReserveAsset>][] = [
    [
      "Ardoise account",
      usdcOf(arcClient, gateway.arcUsdc, account).then((units) => usdcAsset(units, network.arc.label, "Ardoise account", "instant")),
    ],
    ...gatewaySources(owner),
    [
      "wallet USDC",
      usdcOf(baseClient, gateway.sourceUsdc, owner).then((units) => usdcAsset(units, network.base.label, "Wallet", "manual")),
    ],
  ];
  // Testnet ETH has no value: it is left out rather than priced at mainnet's.
  if (network.name === "mainnet") {
    sources.push([
      "wallet ETH",
      Promise.all([baseClient.getBalance({ address: owner }), ethPriceUsd()]).then(([wei, price]) => ({
        asset: "ETH",
        chain: network.base.label,
        place: "Wallet",
        valueUsd: Number(formatUnits(wei, 18)) * price,
        speed: "manual",
      })),
    ]);
  }
  const settled = await Promise.allSettled(sources.map(([, p]) => p));
  const assets: ReserveAsset[] = [];
  const errors: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (result.value.valueUsd > 0) assets.push(result.value);
    } else {
      errors.push(`${sources[i][0]}: ${(result.reason as Error).message.split("\n")[0]}`);
    }
  });
  return { assets, errors };
}

/**
 * Gateway's fee on one transfer from Base to Arc, charged on top of the
 * amount: 0.025307 USDC was taken on mainnet (`contracts/deployments.md`),
 * so this rounds it up for safety.
 */
const GATEWAY_FEE_PER_ORDER = 30_000n;

/**
 * USDC the keeper can actually bring in with these standing orders: each
 * order is all or nothing, and Gateway needs its value plus the fee in the
 * balance. Orders are taken smallest first, as the keeper does, until the
 * balance runs out; an order the balance only partly covers counts for 0.
 *
 * @param balance Gateway balance, USDC units.
 * @param orderValues Value of each unspent standing order, USDC units.
 * @returns The value the keeper can draw.
 */
export function coveredByOrders(balance: bigint, orderValues: bigint[]): bigint {
  let left = balance;
  let covered = 0n;
  for (const value of [...orderValues].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value + GATEWAY_FEE_PER_ORDER > left) break;
    left -= value + GATEWAY_FEE_PER_ORDER;
    covered += value;
  }
  return covered;
}

/**
 * The Gateway balance, split into what the keeper may draw (the standing
 * orders the balance fully covers, fee included) and the rest, which only
 * the owner can move. Without a keeper intake, all of it is the owner's.
 */
function gatewaySources(owner: Address): [string, Promise<ReserveAsset>][] {
  const read = Promise.all([
    gatewayBalance(owner),
    KEEPER_URL ? keeperOrders(KEEPER_URL, owner).then((orders) => orders.map((o) => BigInt(o.value))) : [],
  ]).then(([balance, values]) => ({ balance, covered: coveredByOrders(balance, values) }));
  return [
    ["Gateway standing orders", read.then(({ covered }) => usdcAsset(covered, network.base.label, "Gateway, standing orders", "automatic"))],
    [
      "Gateway balance",
      read.then(({ balance, covered }) => usdcAsset(balance - covered, network.base.label, "Gateway, no standing order", "manual")),
    ],
  ];
}

function usdcAsset(units: bigint, chain: string, place: string, speed: ReserveAsset["speed"]): ReserveAsset {
  // 1 USDC counted as 1 USD, as everywhere in the app.
  return { asset: "USDC", chain, place, valueUsd: Number(formatUnits(units, 6)), speed };
}
