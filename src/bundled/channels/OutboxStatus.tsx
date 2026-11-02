import { Button } from "../../shared/design-system/ui/Button";
import { isWorkflowOperation } from "../../features/workflows/protocol";
import { useState, useSyncExternalStore } from "react";
import type { RelayProfiler } from "../../features/relay/profiling";
import { RelayTimings } from "./RelayTimings";
import { PRODUCT_FEEDBACK_KIND } from "../../features/relay/product-feedback";
import type { Outbox } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";

/** Delivery belongs to the session, including messages from other pages or a previous launch. */
export function OutboxStatus({
  outbox,
  profiling,
  memberAdditions,
}: {
  outbox: Outbox;
  profiling: RelayProfiler;
  memberAdditions: Pick<RelaySession["memberAdditions"], "add">;
}) {
  const operations = useSyncExternalStore(
    outbox.subscribe,
    outbox.snapshot,
    outbox.snapshot,
  ).filter((item) => item.event.kind !== PRODUCT_FEEDBACK_KIND);
  const [error, setError] = useState<string>();

  return (
    <details>
      <summary>Outbox · {operations.length} items</summary>
      <p>Removing an item from the outbox does not delete a sent message.</p>
      <ul
        style={{
          maxHeight: "10rem",
          overflow: "auto",
          paddingInlineStart: "1.2rem",
        }}
      >
        {operations.map((item) => (
          <li key={item.event.id}>
            <span>
              {item.event.kind === 9000
                ? `Add agent ${item.event.tags.find(([tag]) => tag === "p")?.[1]?.slice(0, 12) ?? ""}`
                : item.event.content.slice(0, 100)}{" "}
              ·{" "}
              {
                {
                  sending: "Sending",
                  accepted: "Sent",
                  unknown: "Unconfirmed",
                  failed: "Not sent",
                  seen: "Sent",
                }[item.delivery]
              }
            </span>{" "}
            {!isWorkflowOperation(item.event) &&
              !item.guarded &&
              (item.delivery === "failed" || item.delivery === "unknown") && (
                <Button
                  type="button"
                  onClick={async () => {
                    try {
                      if (
                        item.event.kind === 9000 &&
                        item.recovery?.key.startsWith("member-add:")
                      ) {
                        const channelId = item.event.tags.find(
                          ([tag]) => tag === "h",
                        )?.[1];
                        const pubkey = item.event.tags.find(
                          ([tag]) => tag === "p",
                        )?.[1];
                        if (!channelId || !pubkey)
                          throw new Error(
                            "Reopen Members to check this addition.",
                          );
                        // A stale explicit role must never overwrite a newer admission.
                        await memberAdditions.add(channelId, pubkey);
                      } else outbox.retry(item.event.id);
                      setError(undefined);
                    } catch (reason) {
                      setError(String(reason));
                    }
                  }}
                >
                  Retry
                </Button>
              )}{" "}
            {item.guarded &&
              (item.delivery === "failed" || item.delivery === "unknown") && (
                <span>
                  Retry from the channel or agent profile after checking
                  membership.
                </span>
              )}{" "}
            {item.delivery !== "sending" && (
              <Button
                type="button"
                onClick={async () => {
                  try {
                    const shareReceipt =
                      item.event.kind === 9 &&
                      // Share receipts, including those of earlier flows.
                      /^(snapshot-share:(agent|team)|solo-share-link:[^:]+|agent-share:[^:]+):.+$/.test(
                        item.recovery?.key ?? "",
                      ) &&
                      (item.delivery === "accepted" ||
                        item.delivery === "seen");
                    if (shareReceipt) await outbox.acknowledge(item.event.id);
                    await outbox.dismiss(item.event.id);
                    setError(undefined);
                  } catch (reason) {
                    setError(String(reason));
                  }
                }}
              >
                Remove from outbox
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <RelayTimings profiling={profiling} />
    </details>
  );
}
