import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { arc } from "viem/chains";
import { arcClient } from "@/lib/arc";
import { network } from "@/lib/network";
import type { Venue } from "@/lib/ardoise";

// The cirBTC lending markets only exist on Arc mainnet, so rates are always
// read there, even when the rest of the app runs on testnet. Addresses are
// listed in docs/api.md and checked on chain.
const AAVE_CORE_HUB = "0x17288dfc86205301064577b98B02b81017e6F79C";
const AAVE_USDC_ASSET_ID = 0n;
const AAVE_MAIN_SPOKE = "0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d";
const MORPHO = "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD";
// Flagship cirBTC/USDC market (86% LLTV), the one Circle's Borrow Kit uses.
const MORPHO_CIRBTC_USDC: Hex =
  "0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d";

const RAY = 10n ** 27n;
const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

const aaveHubAbi = parseAbi([
  "function getAssetDrawnRate(uint256 assetId) view returns (uint256)",
  "function getAssetLiquidity(uint256 assetId) view returns (uint256)",
]);
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
 * Until the venue adapters are deployed (A1), the app reads Aave V4 and
 * Morpho directly; after that, `IVenue.rate()` and `IVenue.available()`
 * return the same figures.
 *
 * @returns Aave V4 and Morpho, with their yearly rate (APR) in basis points.
 * @throws If Arc mainnet cannot be read.
 */
export async function readVenueRates(): Promise<Venue[]> {
  const [aave, morpho] = await Promise.all([readAave(), readMorpho()]);
  return [aave, morpho];
}

async function readAave(): Promise<Venue> {
  const [rate, liquidity] = await Promise.all([
    mainnetClient.readContract({
      address: AAVE_CORE_HUB,
      abi: aaveHubAbi,
      functionName: "getAssetDrawnRate",
      args: [AAVE_USDC_ASSET_ID],
    }),
    mainnetClient.readContract({
      address: AAVE_CORE_HUB,
      abi: aaveHubAbi,
      functionName: "getAssetLiquidity",
      args: [AAVE_USDC_ASSET_ID],
    }),
  ]);
  // Hub rates are yearly, in RAY. Liquidity is Hub-wide; if the Main Spoke
  // has a lower draw cap, AaveV4Adapter.available() (A1) is the figure that
  // counts, and C4 reads it instead of this.
  // Stand-in until AaveV4Adapter is deployed (A1); see Venue.address.
  return { id: "aave-v4", address: AAVE_MAIN_SPOKE, name: "Aave V4", rateBps: Number((rate * 10_000n) / RAY), available: liquidity };
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
    // Stand-in until a Morpho adapter exists (R5); see Venue.address.
    address: MORPHO,
    name: "Morpho",
    rateBps: Number((perSecond * SECONDS_PER_YEAR * 10_000n) / WAD),
    // Stored totals, without the interest accrued since the last update:
    // close enough for display; C4 reads the adapter's available() instead.
    available: totalSupplyAssets - totalBorrowAssets,
  };
}
