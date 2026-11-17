import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { createPublicClient, createWalletClient, http } from "viem";
import { arc } from "viem/chains";

import { loadConfig } from "./config.js";
import { GATEWAY_MAINNET, GatewayFunder, parseOrders } from "./gateway.js";
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
 * Delay between two passes. Each pass makes a few reads per account, so
 * following every Arc block would only load the RPC endpoint without making
 * a repayment noticeably faster.
 */
const PASS_INTERVAL_MS = 10_000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} [keeper] ${message}`);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.factory === null) {
    log("ARDOISE_FACTORY_ADDRESS is empty: the factory is not deployed yet, nothing to watch. Exiting.");
    return;
  }

  const transport = http(config.rpcUrl);
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
  const gateway =
    ordersFile === null
      ? undefined
      : new GatewayFunder({
          network: GATEWAY_MAINNET,
          loadOrders: async () => parseOrders(JSON.parse(await readFile(ordersFile, "utf8"))),
          log,
          dryRun: walletClient === null,
        });
  log(
    gateway === undefined
      ? "GATEWAY_ORDERS_FILE is empty: no standing orders, the keeper only sweeps balances already on accounts"
      : `standing orders read from ${ordersFile}: under the minimum, the keeper draws USDC from Gateway`,
  );

  const keeper = new Keeper({ publicClient, walletClient, factory: config.factory, fromBlock, log, gateway });
  for (;;) {
    try {
      await keeper.tick();
    } catch (error) {
      log(`pass failed, retrying: ${errorMessage(error)}`);
    }
    await sleep(PASS_INTERVAL_MS);
  }
}

main().catch((error: unknown) => {
  console.error(`[keeper] ${errorMessage(error)}`);
  process.exitCode = 1;
});
