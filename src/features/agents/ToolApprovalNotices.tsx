import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { ToolApprovals } from "./tool-approval";

/** One notice for each plugin tool call waiting for the owner. Nothing runs
 * until they answer, and there is no dismiss: closing it would not answer. */
export function ToolApprovalNotices({
  approvals,
}: {
  approvals: ToolApprovals;
}) {
  const pending = useSyncExternalStore(approvals.subscribe, approvals.pending);
  return pending.map((request) => (
    <ToastNotice
      key={request.id}
      title={request.title}
      description={`${request.agent} wants to use ${request.tool} (${request.plugin}). ${request.detail}`}
      tone="warning"
    >
      <Button
        type="button"
        size="sm"
        variant="prominent"
        onClick={() => approvals.answer(request.id, "once")}
      >
        Allow once
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => approvals.answer(request.id, "always")}
      >
        Always allow
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => approvals.answer(request.id, "deny")}
      >
        Deny
      </Button>
    </ToastNotice>
  ));
}
