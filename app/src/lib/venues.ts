import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { arc } from "viem/chains";
import { arcClient } from "@/lib/arc";
import { network } from "@/lib/network";
import type { Venue } from "@/lib/ardoise";
import { venueAbi } from "@/lib/contracts/abis";
import { MAINNET_DEPLOYMENT } from "@/lib/contracts/deployments";

// The cirBTC lending markets only exist on Arc mainnet, so rates are always
// read there, even when the rest of the app runs on testnet. Addresses are
// listed in docs/api.md and checked on chain.
const MORPHO = "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD";
// Flagship cirBTC/USDC market (86% LLTV), the one Circle's Borrow Kit uses.
const MORPHO_CIRBTC_USDC: Hex =
  "0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d";

const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const irmAbi = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

const mainnetClient =
  network.name === "mainnet"
    ? arcClient
    : createPublicClient({ chain: arc, transport: http(undefined, { timeout: 3_000, retryCount: 1 }) });

/**
 * Reads the live USDC borrow rate and liquidity of each venue on Arc mainnet.
 *
 * Aave V4 is read through the deployed `AaveV4Adapter` (`IVenue.rate()` and
 * `available()`), the venue accounts borrow from. Morpho has no adapter yet
 * (R5): it is read directly and marked as not borrowable, for comparison.
 *
 * @returns Aave V4 and Morpho, with their yearly rate (APR) in basis points.
 * @throws If Arc mainnet cannot be read.
 */
export async function readVenueRates(): Promise<Venue[]> {
  const [aave, morpho] = await Promise.all([readAave(), readMorpho()]);
  return [aave, morpho];
}

async function readAave(): Promise<Venue> {
  // Read through Ardoise's own adapter: its rate() and available() are the
  // figures bestVenue() compares, and available() includes the Main Spoke's
  // draw cap, which the Hub-wide liquidity does not.
  const adapter = { address: MAINNET_DEPLOYMENT.aaveAdapter, abi: venueAbi } as const;
  const [rateBps, available] = await Promise.all([
    mainnetClient.readContract({ ...adapter, functionName: "rate" }),
    mainnetClient.readContract({ ...adapter, functionName: "available" }),
  ]);
  return { id: "aave-v4", address: MAINNET_DEPLOYMENT.aaveAdapter, name: "Aave V4", rateBps: Number(rateBps), available };
}

async function readMorpho(): Promise<Venue> {
  const [params, market] = await Promise.all([
    mainnetClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [MORPHO_CIRBTC_USDC] }),
    mainnetClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [MORPHO_CIRBTC_USDC] }),
  ]);
  const [loanToken, collateralToken, oracle, irm, lltv] = params;
  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = market;
  const perSecond = await mainnetClient.readContract({
    address: irm,
    abi: irmAbi,
    functionName: "borrowRateView",
    args: [
      { loanToken, collateralToken, oracle, irm, lltv },
      { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee },
    ],
  });
  // Morpho IRMs return a per-second rate in WAD; scale it to a yearly APR
  // so it compares with Aave's.
  return {
    id: "morpho",
    // No Morpho adapter yet (R5): shown for comparison, never borrowed from.
    address: MORPHO,
    borrowable: false,
    name: "Morpho",
    rateBps: Number((perSecond * SECONDS_PER_YEAR * 10_000n) / WAD),
    // Stored totals, without the interest accrued since the last update:
    // close enough for a venue shown for comparison only.
    available: totalSupplyAssets - totalBorrowAssets,
  };
}
