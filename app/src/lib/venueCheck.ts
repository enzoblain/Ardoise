import { encodeFunctionData, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { accountAbi } from "@/lib/contracts/abis";
import type { Deployment } from "@/lib/contracts/deployments";
import { network } from "@/lib/network";
import { sendFromPasskey, switchChain, type Call, type ConnectedWallet } from "@/lib/wallet";

/** How the account's accepted venues compare with the adapters the app was built for. */
export interface VenueReport {
  /** Accepted venues that are not one of the deployment's adapters: to revoke before granting allowances. */
  unexpected: Address[];
  /** Deployment adapters the account has not accepted: payments through them fail with `UnknownVenue`. */
  missing: Address[];
}

/**
 * The venues an account of this deployment is expected to accept: the Aave V4
 * adapter, and the Morpho adapter when the factory has one.
 *
 * @param deployment Deployed addresses.
 * @returns The adapters' addresses.
 */
export function expectedVenues(deployment: Deployment): Address[] {
  return deployment.morphoAdapter === null ? [deployment.aaveAdapter] : [deployment.aaveAdapter, deployment.morphoAdapter];
}

/**
 * Compares the account's accepted venues with the expected ones, ignoring the
 * case of the addresses. The account accepts the factory's list as it stands
 * when it is created, and the admin can change that list just before
 * (docs/api.md, *Accepted venues*): anything else must be revoked first.
 *
 * @param accepted What `acceptedVenues()` returned.
 * @param expected What `expectedVenues()` returned.
 * @returns The unexpected and the missing venues, each in its input order and without duplicates.
 */
export function compareVenues(accepted: readonly Address[], expected: readonly Address[]): VenueReport {
  const key = (a: Address) => a.toLowerCase();
  const acceptedKeys = new Set(accepted.map(key));
  const expectedKeys = new Set(expected.map(key));
  const unique = (list: readonly Address[]) => list.filter((a, i) => list.findIndex((b) => key(b) === key(a)) === i);
  return {
    unexpected: unique(accepted.filter((a) => !expectedKeys.has(key(a)))),
    missing: unique(expected.filter((a) => !acceptedKeys.has(key(a)))),
  };
}

/**
 * Whether the remaining setup steps that grant allowances must wait: while
 * the report is unknown (not read yet, or the read failed) or an unexpected
 * venue is accepted. A missing venue does not block: it only limits where
 * the account can borrow.
 *
 * @param report The comparison, or `undefined` before it is known.
 * @returns `true` when allowances must not be granted yet.
 */
export function venuesBlockSetup(report: VenueReport | undefined): boolean {
  return report === undefined || report.unexpected.length > 0;
}

/**
 * Reads the account's accepted venues and compares them with the deployment's adapters.
 *
 * @param client Public client on Arc.
 * @param deployment Deployed addresses.
 * @param account The owner's `ArdoiseAccount`.
 * @returns The comparison.
 */
export async function readVenueReport(
  client: PublicClient<Transport, Chain>,
  deployment: Deployment,
  account: Address,
): Promise<VenueReport> {
  const accepted = await client.readContract({ address: account, abi: accountAbi, functionName: "acceptedVenues" });
  return compareVenues(accepted, expectedVenues(deployment));
}

/**
 * The `revokeVenue(venue)` call on the owner's account, for a smart account batch.
 *
 * @param account The owner's `ArdoiseAccount`.
 * @param venue Venue to revoke.
 * @returns The contract call.
 */
export function revokeVenueCall(account: Address, venue: Address): Call {
  return { to: account, data: encodeFunctionData({ abi: accountAbi, functionName: "revokeVenue", args: [venue] }) };
}

/**
 * Revokes a venue from the owner's wallet, the way payments are sent: one
 * transaction from a browser wallet on Arc, or one passkey user operation.
 *
 * @param wallet The owner's connected wallet.
 * @param client Public client on Arc, to wait for the receipt.
 * @param account The owner's `ArdoiseAccount`.
 * @param venue Venue to revoke.
 * @returns The hash of the transaction that carried the call.
 * @throws If the wallet refuses, or the call reverts (`VenueNotAccepted`, `NotOwner`).
 */
export async function sendRevokeVenue(
  wallet: ConnectedWallet,
  client: PublicClient<Transport, Chain>,
  account: Address,
  venue: Address,
): Promise<Hex> {
  if (wallet.kind === "passkey") return sendFromPasskey(wallet, [revokeVenueCall(account, venue)]);
  // The wallet may still be on Base after a deposit from the Protection panel.
  await switchChain(wallet.provider, network.arc.chain);
  const hash = await wallet.client.writeContract({
    account: wallet.client.account,
    chain: wallet.client.chain,
    address: account,
    abi: accountAbi,
    functionName: "revokeVenue",
    args: [venue],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return hash;
}
