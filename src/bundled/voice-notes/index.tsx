import { MicrophoneIcon } from "../../shared/design-system/icons";
import type { PluginModule } from "../../plugins/api";
import { VoiceCapture } from "./VoiceCapture";
import { VoiceNoteCard } from "./VoiceNoteCard";
import { isVoiceNoteAttachment } from "./audio";
import { IconButton } from "../../shared/design-system/ui/IconButton";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerTool({
    id: "recorder",
    title: "Voice Notes",
    order: 10,
    component: ({ session, disabled, capture, focus }) =>
      session.attachments && capture ? (
        <IconButton
          type="button"
          size="sm"
          aria-label="Record voice note"
          title="Record voice note"
          disabled={disabled}
          onClick={() =>
            capture(({ accept, cancel }) => (
              <VoiceCapture
                accept={(recording) => {
                  const accepted = accept(recording);
                  if (accepted) focus();
                  return accepted;
                }}
                cancel={() => {
                  cancel();
                  focus();
                }}
              />
            ))
          }
          icon={<MicrophoneIcon size={16} aria-hidden="true" />}
        />
      ) : null,
  });
  ctx.conversation.registerAttachment({
    id: "player",
    title: "Voice note",
    matches: (attachment) =>
      attachment.voiceNote === true ||
      isVoiceNoteAttachment({
        m: attachment.mime ?? "",
        filename: attachment.name ?? "",
      }),
    component: ({ attachment, source, onRemove }) => (
      <VoiceNoteCard
        source={source}
        downloadName={attachment.name ?? ""}
        {...(attachment.duration === undefined
          ? {}
          : { duration: attachment.duration })}
        {...(attachment.waveform ? { waveform: attachment.waveform } : {})}
        {...(onRemove ? { onRemove } : {})}
      />
    ),
  });
};
