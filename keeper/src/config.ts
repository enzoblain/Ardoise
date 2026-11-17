import { isAddress, isHex, type Address, type Hex } from "viem";

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
  /** Key of the keeper wallet, or `null` to run without sending transactions. */
  privateKey: Hex | null;
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

  return {
    rpcUrl: env.ARC_RPC_URL?.trim() || undefined,
    factory,
    factoryDeployBlock: deployBlock === null ? null : BigInt(deployBlock),
    privateKey,
  };
}
