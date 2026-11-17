"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import {
  fetchDelivery,
  measureDeliverySeconds,
  type Delivery,
} from "@/lib/delivery";
import { chainByDomain, network, txUrl } from "@/lib/network";

const POLL_MS = 2_000;

/**
 * Live status of a cross-chain payment: sent on Arc, attested by Circle,
 * delivered on the destination chain. Polls Iris until the payment is
 * delivered or failed.
 *
 * @param props.sourceTxHash Hash of the payment's burn transaction on Arc.
 */
export function DeliveryTracker({ sourceTxHash }: { sourceTxHash: Hex }) {
  const [delivery, setDelivery] = useState<Delivery>();
  const [seconds, setSeconds] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const next = await fetchDelivery(sourceTxHash);
        if (stopped) return;
        setDelivery(next);
        setError(undefined);
        if (next.stage === "delivered") {
          setSeconds(await measureDeliverySeconds(next));
          return;
        }
        if (next.stage === "failed") return;
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      timer = setTimeout(poll, POLL_MS);
    }

    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sourceTxHash]);

  const destination =
    delivery?.destinationDomain !== undefined
      ? chainByDomain(delivery.destinationDomain)
      : undefined;
  const stage = delivery?.stage;

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        <Step
          done
          label={`Sent on ${network.arc.label}`}
          href={txUrl(network.arc, sourceTxHash)}
        />
        <Step
          done={stage === "delivering" || stage === "delivered"}
          active={stage === undefined || stage === "not_found" || stage === "attesting"}
          label="Attested by Circle (CCTP)"
          detail={delivery?.delayReason ? `Delayed: ${delivery.delayReason}` : undefined}
        />
        <Step
          done={stage === "delivered"}
          active={stage === "delivering"}
          failed={stage === "failed"}
          label={`Delivered on ${destination?.label ?? "destination chain"}`}
          href={
            destination && delivery?.mintTxHash
              ? txUrl(destination, delivery.mintTxHash)
              : undefined
          }
          detail={
            stage === "delivered" && seconds !== undefined
              ? `${seconds} s after it was sent`
              : undefined
          }
        />
      </ol>

      {delivery?.amount && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="opacity-60">Sent</dt>
          <dd>{delivery.amount} USDC</dd>
          <dt className="opacity-60">Received</dt>
          <dd>{delivery.received} USDC</dd>
          <dt className="opacity-60">Transfer fee</dt>
          <dd>{delivery.fee} USDC</dd>
          <dt className="opacity-60">Recipient</dt>
          <dd className="break-all font-mono">{delivery.recipient}</dd>
        </dl>
      )}

      {stage === "not_found" && (
        <p className="text-sm opacity-70">
          Waiting for Circle to index the transfer. A same-chain payment on{" "}
          {network.arc.label} never shows up here.
        </p>
      )}
      {error && <p className="text-sm text-red-600">Could not reach Circle: {error}</p>}
    </div>
  );
}

function Step(props: {
  label: string;
  done?: boolean;
  active?: boolean;
  failed?: boolean;
  href?: string;
  detail?: string;
}) {
  const icon = props.failed ? "✕" : props.done ? "✓" : props.active ? "…" : "○";
  return (
    <li className="flex gap-3">
      <span aria-hidden className="w-4 text-center font-mono">
        {icon}
      </span>
      <span className="flex flex-col">
        {props.href ? (
          <a href={props.href} target="_blank" rel="noreferrer" className="underline">
            {props.label}
          </a>
        ) : (
          <span className={props.done || props.active ? "" : "opacity-50"}>
            {props.label}
          </span>
        )}
        {props.detail && <span className="text-sm opacity-70">{props.detail}</span>}
      </span>
    </li>
  );
}
