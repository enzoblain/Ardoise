import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { arcClient } from "@/lib/arc";
import { gateway, gatewayBalance } from "@/lib/gateway";
import { network } from "@/lib/network";
import type { ReserveAsset } from "@/lib/stress";

/**
 * Chainlink ETH / USD on Base mainnet (8 decimals), checked on chain
 * (`description()` is "ETH / USD"). Prices are the same on every network, so
 * the testnet app reads it too.
 */
const ETH_USD_FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
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
  const [, answer] = await baseMainnet.readContract({ address: ETH_USD_FEED, abi: feedAbi, functionName: "latestRoundData" });
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
 * reserve on Base (drawn by the keeper through standing orders), and USDC
 * and ETH in the owner's wallet on Base (the owner would deposit or swap
 * them by hand). Each source is read on its own: one that fails is reported
 * and left out.
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
    ["Gateway reserve", gatewayBalance(owner).then((units) => usdcAsset(units, network.base.label, "Gateway reserve", "automatic"))],
    [
      "wallet USDC",
      usdcOf(baseClient, gateway.sourceUsdc, owner).then((units) => usdcAsset(units, network.base.label, "Wallet", "manual")),
    ],
    [
      "wallet ETH",
      Promise.all([baseClient.getBalance({ address: owner }), ethPriceUsd()]).then(([wei, price]) => ({
        asset: "ETH" as const,
        chain: network.base.label,
        place: "Wallet",
        valueUsd: Number(formatUnits(wei, 18)) * price,
        speed: "manual" as const,
      })),
    ],
  ];
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
 * The demo account's reserve, simulated like its position: a Gateway reserve
 * and a wallet on Base. ETH is valued at the live price when it can be read.
 *
 * @returns The simulated reserve.
 */
export async function demoReserve(): Promise<ReserveRead> {
  const assets: ReserveAsset[] = [
    { asset: "USDC", chain: "Base", place: "Gateway reserve", valueUsd: 30, speed: "automatic" },
    { asset: "USDC", chain: "Base", place: "Wallet", valueUsd: 15, speed: "manual" },
  ];
  try {
    assets.push({ asset: "ETH", chain: "Base", place: "Wallet", valueUsd: 0.02 * (await ethPriceUsd()), speed: "manual" });
    return { assets, errors: [] };
  } catch (e) {
    return { assets, errors: [`ETH price: ${(e as Error).message.split("\n")[0]}`] };
  }
}

function usdcAsset(units: bigint, chain: string, place: string, speed: ReserveAsset["speed"]): ReserveAsset {
  // 1 USDC counted as 1 USD, as everywhere in the app.
  return { asset: "USDC", chain, place, valueUsd: Number(formatUnits(units, 6)), speed };
}
