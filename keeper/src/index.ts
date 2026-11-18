import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { createPublicClient, createWalletClient, http } from "viem";
import { arc, base } from "viem/chains";

import { loadConfig } from "./config.js";
import { factoryAbi } from "./abis.js";
import { GATEWAY_MAINNET, GatewayFunder, parseOrders } from "./gateway.js";
import { accountOrNull, burnIntentTypedData, startIntake } from "./intake.js";
import { Keeper, errorMessage } from "./keeper.js";

/**
 * Keeper entry point (tasks B2 and B4 in docs/roadmap.md).
 *
 * Follows Arc mainnet and, for every Ardoise account of the factory, applies
 * the USDC waiting on the account to its debt by calling the public
 * `IArdoise.sweep()`. When a position is under the guard's minimum and the
 * account has nothing to repay with, it submits the owner's Gateway standing
 * orders so that USDC from Base arrives on the account. It reads its
 * settings from the repo-root `.env`.
 */

/**
 * Delay between two passes. Each pass makes about ten reads, and the public
 * Arc RPC answers 429 (too many requests) when it is polled too often, so
 * the keeper stays well under one request per second. A repayment a few
 * seconds later changes nothing for the user.
 */
const PASS_INTERVAL_MS = 15_000;

/**
 * Retries of a single RPC request. viem retries a 429 or a network error
 * with an exponential delay (0.5 s, 1 s, 2 s, 4 s, 8 s here) and follows the
 * `Retry-After` header when the endpoint sends one.
 */
const RPC_RETRY = { retryCount: 5, retryDelay: 500 } as const;

/** Longest wait after passes that keep failing (the delay doubles each time). */
const MAX_PASS_DELAY_MS = 120_000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} [keeper] ${message}`);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.factory === null) {
    log("ARDOISE_FACTORY_ADDRESS is empty: the factory is not deployed yet, nothing to watch. Exiting.");
    return;
  }

  const transport = http(config.rpcUrl, RPC_RETRY);
  const publicClient = createPublicClient({ chain: arc, transport });
  const walletClient =
    config.keeperAccount === null
      ? null
      : createWalletClient({ account: config.keeperAccount, chain: arc, transport });

  let fromBlock = config.factoryDeployBlock;
  if (fromBlock === null) {
    fromBlock = await publicClient.getBlockNumber();
    log(
      `ARDOISE_FACTORY_DEPLOY_BLOCK is empty: only accounts created from block ${fromBlock} on will be watched`,
    );
  }

  log(`factory ${config.factory}, accounts read from block ${fromBlock}`);
  log(
    walletClient === null
      ? "KEEPER_PRIVATE_KEY is empty: dry run, decisions are logged and nothing is sent"
      : `keeper wallet ${walletClient.account.address} (needs a little USDC for gas)`,
  );

  const ordersFile = config.gatewayOrdersFile;
  // The file is read on every funding attempt; report each bad entry once.
  const reportedEntries = new Set<number>();
  const gateway =
    ordersFile === null
      ? undefined
      : new GatewayFunder({
          network: GATEWAY_MAINNET,
          loadOrders: async () =>
            parseOrders(JSON.parse(await readFile(ordersFile, "utf8")), (index) => {
              if (reportedEntries.has(index)) return;
              reportedEntries.add(index);
              log(`standing order ${index} in ${ordersFile} is malformed, skipped`);
            }),
          log,
          dryRun: walletClient === null,
        });
  log(
    gateway === undefined
      ? "GATEWAY_ORDERS_FILE is empty: no standing orders, the keeper only sweeps balances already on accounts"
      : `standing orders read from ${ordersFile}: under the minimum, the keeper draws USDC from Gateway`,
  );

  if (config.intakePort !== null && ordersFile !== null) {
    const factory = config.factory;
    const baseClient = createPublicClient({ chain: base, transport: http(config.baseRpcUrl) });
    startIntake({
      port: config.intakePort,
      host: "127.0.0.1",
      ordersFile,
      allowedOrigin: config.appOrigin,
      network: GATEWAY_MAINNET,
      checks: {
        accountOf: async (owner) =>
          accountOrNull(await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "accountOf", args: [owner] })),
        // Handles plain wallets and ERC-1271 smart accounts (passkeys) on Base, the orders' source chain.
        verifySignature: (order, depositor) =>
          baseClient.verifyTypedData({ address: depositor, signature: order.signature, ...burnIntentTypedData(order) }),
        isContract: async (depositor) => {
          const code = await baseClient.getCode({ address: depositor });
          // 0xef0100 + address is an EIP-7702 delegation, set on an EOA.
          return code !== undefined && !code.startsWith("0xef0100");
        },
        sourceBlockNumber: () => baseClient.getBlockNumber(),
        isUsed: (order) => gateway?.isUsed(order) ?? false,
      },
      log,
    });
    log(`standing-order intake on http://127.0.0.1:${config.intakePort}/orders for ${config.appOrigin}`);
  }

  const keeper = new Keeper({ publicClient, walletClient, factory: config.factory, fromBlock, log, gateway });
  let delay = PASS_INTERVAL_MS;
  for (;;) {
    try {
      await keeper.tick();
      delay = PASS_INTERVAL_MS;
    } catch (error) {
      delay = Math.min(delay * 2, MAX_PASS_DELAY_MS);
      log(`pass failed, retrying in ${delay / 1000} s: ${errorMessage(error)}`);
    }
    await sleep(delay);
  }
}

main().catch((error: unknown) => {
  console.error(`[keeper] ${errorMessage(error)}`);
  process.exitCode = 1;
});
