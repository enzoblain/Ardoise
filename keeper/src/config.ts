import { isAddress, isHex, type Address, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** USDC on Arc mainnet (6 decimals through its ERC-20 interface). */
export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";

/** Settings read from the environment (the repo-root `.env`, see `.env.example`). */
export interface Config {
  /** Arc RPC endpoint, or `undefined` for the public one. */
  rpcUrl: string | undefined;
  /** Ardoise factory, or `null` while it is not deployed. */
  factory: Address | null;
  /** Block the factory was deployed at, or `null` to start from the current block. */
  factoryDeployBlock: bigint | null;
  /** Keeper wallet, or `null` to run without sending transactions. */
  keeperAccount: PrivateKeyAccount | null;
  /** JSON file of Gateway standing orders (B4), or `null` to never draw from Gateway. */
  gatewayOrdersFile: string | null;
  /** Port of the standing-order intake the app posts to, or `null` to not run it. */
  intakePort: number | null;
  /** Browser origin allowed to call the intake (the app). */
  appOrigin: string;
  /** Base RPC endpoint, to check order signatures, or `undefined` for the public one. */
  baseRpcUrl: string | undefined;
}

/**
 * Reads and validates the keeper settings.
 *
 * @param env Environment variables, `process.env` in production.
 * @returns The validated configuration.
 * @throws Error naming the invalid variable. The message never contains the
 * value, since one of the variables is a private key.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const factory = env.ARDOISE_FACTORY_ADDRESS?.trim() || null;
  if (factory !== null && !isAddress(factory)) {
    throw new Error("ARDOISE_FACTORY_ADDRESS is not a valid address");
  }

  const deployBlock = env.ARDOISE_FACTORY_DEPLOY_BLOCK?.trim() || null;
  if (deployBlock !== null && !/^\d+$/.test(deployBlock)) {
    throw new Error("ARDOISE_FACTORY_DEPLOY_BLOCK is not a block number");
  }

  const privateKey = env.KEEPER_PRIVATE_KEY?.trim() || null;
  if (privateKey !== null && !(isHex(privateKey) && privateKey.length === 66)) {
    throw new Error("KEEPER_PRIVATE_KEY is not a 32-byte hex key starting with 0x");
  }

  let keeperAccount: PrivateKeyAccount | null = null;
  if (privateKey !== null) {
    try {
      keeperAccount = privateKeyToAccount(privateKey);
    } catch {
      // The library's own error quotes the rejected value; replace it.
      throw new Error("KEEPER_PRIVATE_KEY is not a valid secp256k1 private key");
    }
  }

  const intakePort = env.GATEWAY_INTAKE_PORT?.trim() || null;
  if (intakePort !== null && !(/^\d+$/.test(intakePort) && Number(intakePort) > 0 && Number(intakePort) < 65_536)) {
    throw new Error("GATEWAY_INTAKE_PORT is not a port number");
  }
  if (intakePort !== null && !env.GATEWAY_ORDERS_FILE?.trim()) {
    throw new Error("GATEWAY_INTAKE_PORT needs GATEWAY_ORDERS_FILE to store the orders in");
  }

  return {
    rpcUrl: env.ARC_RPC_URL?.trim() || undefined,
    factory,
    factoryDeployBlock: deployBlock === null ? null : BigInt(deployBlock),
    keeperAccount,
    gatewayOrdersFile: env.GATEWAY_ORDERS_FILE?.trim() || null,
    intakePort: intakePort === null ? null : Number(intakePort),
    appOrigin: env.APP_ORIGIN?.trim() || "http://localhost:3000",
    baseRpcUrl: env.BASE_RPC_URL?.trim() || undefined,
  };
}
