import { getAddress, isAddress } from "viem";
import { createAccountEvents, eventsToJson } from "@/lib/accountEvents";
import { arcClient } from "@/lib/arc";
import { deployment } from "@/lib/contracts/deployments";

export const dynamic = "force-dynamic";

// One store per server instance, shared by every visitor it serves.
const store = deployment ? createAccountEvents(arcClient, deployment.factory, deployment.deployBlock) : null;

/**
 * `GET /api/account-events?owner=…&account=…`: the `Paid` / `LineRepaid`
 * history of an owner's Ardoise account and its block times, read on the
 * server and kept between requests (lib/accountEvents.ts). The statement asks
 * here first and scans the chain itself only if this fails.
 *
 * @returns 200 with `AccountEventsJson`; 400 for malformed addresses; 404
 *   when `account` is not the factory's account of `owner`, or no contracts
 *   are deployed on this network; 502 when Arc cannot be read.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const owner = params.get("owner") ?? "";
  const account = params.get("account") ?? "";
  if (!isAddress(owner) || !isAddress(account)) return Response.json({ error: "owner and account must be addresses" }, { status: 400 });
  if (!store) return Response.json({ error: "no contracts on this network" }, { status: 404 });
  try {
    const events = await store.read(getAddress(owner), getAddress(account));
    if (!events) return Response.json({ error: "not this owner's Ardoise account" }, { status: 404 });
    return Response.json(eventsToJson(events), { headers: { "cache-control": "no-store" } });
  } catch {
    // The RPC error may carry a keyed ARC_RPC_URL: never return it.
    return Response.json({ error: "Arc could not be read" }, { status: 502 });
  }
}
