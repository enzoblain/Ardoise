"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { arcClient } from "@/lib/arc";
import type { Deployment } from "@/lib/contracts/deployments";
import { network, txUrl } from "@/lib/network";
import { readVenueReport, sendRevokeVenue, venuesBlockSetup, type VenueReport } from "@/lib/venueCheck";
import type { ConnectedWallet } from "@/lib/wallet";

/** State of the accepted-venues check for one account. */
export interface VenueCheckState {
  deployment: Deployment;
  account: Address | null;
  report?: VenueReport;
  error?: string;
  /** Whether setup steps that grant allowances must wait (see `venuesBlockSetup`). */
  blocked: boolean;
  refresh: () => Promise<void>;
}

/**
 * Reads the account's `acceptedVenues()` and compares them with the
 * deployment's adapters, once the account exists (docs/api.md, *Accepted venues*).
 *
 * @param deployment Deployed addresses.
 * @param account The owner's `ArdoiseAccount`, or `null` before `createAccount()`.
 * @returns The check's state; `blocked` is `false` while there is no account yet.
 */
export function useVenueCheck(deployment: Deployment, account: Address | null): VenueCheckState {
  const [report, setReport] = useState<VenueReport>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (account === null) return;
    try {
      setReport(await readVenueReport(arcClient, deployment, account));
      setError(undefined);
    } catch (e) {
      setReport(undefined);
      setError((e as Error).message.split("\n")[0]);
    }
  }, [deployment, account]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { deployment, account, report, error, blocked: account !== null && venuesBlockSetup(report), refresh };
}

/**
 * Warns about the account's accepted venues: an unexpected one, with a
 * "Revoke" action calling `revokeVenue(venue)` from the owner's wallet, and
 * an expected adapter the account has not accepted. Renders nothing when the
 * venues match.
 *
 * @param props.check State from `useVenueCheck`.
 * @param props.wallet The owner's connected wallet, which signs the revocation.
 */
export function VenueWarning({ check, wallet }: { check: VenueCheckState; wallet: ConnectedWallet }) {
  const [revoking, setRevoking] = useState<Address>();
  const [lastTx, setLastTx] = useState<`0x${string}`>();
  const [error, setError] = useState<string>();
  const { account, report, deployment } = check;
  if (account === null) return null;

  const name = (venue: Address) =>
    venue.toLowerCase() === deployment.aaveAdapter.toLowerCase()
      ? "Aave V4"
      : venue.toLowerCase() === deployment.morphoAdapter?.toLowerCase()
        ? "Morpho"
        : venue;

  async function revoke(venue: Address) {
    if (account === null) return;
    setRevoking(venue);
    setError(undefined);
    try {
      setLastTx(await sendRevokeVenue(wallet, arcClient, account, venue));
      await check.refresh();
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setRevoking(undefined);
    }
  }

  if (check.error) {
    return (
      <p className="rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3 text-sm">
        Could not read the venues your account accepted ({check.error}). Allowances wait until they are checked.{" "}
        <button type="button" className="underline" onClick={() => void check.refresh()}>
          Check again
        </button>
      </p>
    );
  }
  if (!report || (report.unexpected.length === 0 && report.missing.length === 0)) return null;

  return (
    <div className="flex flex-col gap-2">
      {report.unexpected.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3 text-sm">
          <p className="font-medium">
            Your account accepted a lending venue Ardoise does not know. Revoke it before granting any allowance or
            sending USDC to the account: an accepted venue is trusted with the USDC the account holds.
          </p>
          <ul className="flex flex-col gap-2">
            {report.unexpected.map((venue) => (
              <li key={venue} className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-xs break-all">{venue}</span>
                <button
                  type="button"
                  disabled={revoking !== undefined}
                  onClick={() => void revoke(venue)}
                  className="btn-primary px-3 py-1.5 text-xs"
                >
                  {revoking === venue ? (wallet.kind === "passkey" ? "Confirm with your passkey…" : "Confirm in your wallet…") : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.missing.length > 0 && (
        <p className="rounded-2xl border border-line bg-surface px-5 py-3 text-sm text-muted">
          Your account has not accepted {report.missing.map(name).join(" and ")}: payments through{" "}
          {report.missing.length > 1 ? "these venues" : "this venue"} will be refused.
        </p>
      )}
      {lastTx && (
        <p className="text-xs text-faint">
          Revoked:{" "}
          <a className="underline" href={txUrl(network.arc, lastTx)} target="_blank" rel="noreferrer">
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

/**
 * The accepted-venues check for an account that already exists, as a notice
 * on the live account screen.
 *
 * @param props.wallet The owner's connected wallet.
 * @param props.deployment Deployed addresses.
 * @param props.account The owner's `ArdoiseAccount`.
 */
export function VenueCheckNotice({ wallet, deployment, account }: { wallet: ConnectedWallet; deployment: Deployment; account: Address }) {
  return <VenueWarning check={useVenueCheck(deployment, account)} wallet={wallet} />;
}
