import { useState } from "react";
import { MessageComposer } from "../../../features/messages/MessageComposer";
import { Select } from "../../../shared/design-system/ui/Select";
import { useComposerFixture } from "./fixture";

const CONTEXTS = [
  {
    group: "Channel",
    value: "channel-start",
    label: "Channel · New message",
    copy: "buzz-design",
    threadRootId: undefined,
  },
  {
    group: "Channel",
    value: "channel-reply",
    label: "Channel · Reply",
    copy: "buzz-design",
    threadRootId: "preview-thread",
  },
  {
    group: "Chat",
    value: "session-reply",
    label: "Chat · Reply",
    copy: "this chat",
    threadRootId: "preview-session",
  },
] as const;
const GROUPS = ["Channel", "Chat"].map((label) => ({
  label,
  options: CONTEXTS.filter((context) => context.group === label),
}));

export function ComposerCopyPreview() {
  const [value, setValue] = useState<string>("channel-start");
  const context =
    CONTEXTS.find((candidate) => candidate.value === value) ?? CONTEXTS[0];
  const props = useComposerFixture({
    channelName: context.copy,
    ...(context.threadRootId ? { threadRootId: context.threadRootId } : {}),
  });
  return (
    <div className="product-specimen">
      <Select
        label="Preview context"
        value={value}
        groups={GROUPS}
        onValueChange={setValue}
      />
      <p className="text-body-sm text-subtle">
        Try mentioning both people named Alice or both agents named Honey.
        Adding the second namesake reveals a short public key on both chips.
      </p>
      <div className="composer-playground-stage">
        <MessageComposer key={context.value} {...props} />
      </div>
    </div>
  );
}
