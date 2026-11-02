import "../../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerAttachments } from "../../../src/features/messages/ComposerAttachments";
import { AudioAttachment } from "../../../src/features/messages/AudioAttachment";
import { MessageRow } from "../../../src/features/messages/MessageRow";
import { VoiceNoteCard } from "../../../src/bundled/voice-notes/VoiceNoteCard";
import type {
  AttachmentRenderer,
  ContributionReader,
} from "../../../src/features/conversation/contracts";
import type { DraftAttachment } from "../../../src/features/messages/attachment-draft";
import { Button } from "../../../src/shared/design-system/ui/Button";
import { Select } from "../../../src/shared/design-system/ui/Select";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../../src/shared/design-system/ui/PanelHeader";
import { FullPageSurface } from "../../../src/shared/design-system/ui/FullPageSurface";
import { ToastProvider } from "../../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../../src/shared/design-system/useKeyboardFocusVisibility";
import { ACCENTS, parseAccent } from "../../../src/shared/theme/accent";
import messageStyles from "../../../src/features/messages/Messages.module.css";
import { files, mediaSamples, draft, media, type Sample } from "./data";
import "./styles.css";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
document.documentElement.dataset.colorMode = mode;
document.documentElement.classList.toggle("dark", mode === "dark");
document.documentElement.dataset.accent = parseAccent(params.get("accent"));
document.documentElement.dataset.colorLevel =
  params.get("contrast") === "high" ? "high" : "touch";
document.documentElement.style.setProperty(
  "--buzz-text-scale",
  params.get("scale") === "2" ? "2" : "1",
);
const voiceEntries: ReturnType<
  ContributionReader<AttachmentRenderer>["snapshot"]
> = [
  {
    id: "voice",
    key: "playground/voice",
    pluginId: "playground",
    revision: "1",
    title: "Voice note",
    matches: (a) => a.voiceNote === true,
    component: ({ attachment, source, onRemove }) => (
      <VoiceNoteCard
        source={source}
        {...(attachment.duration ? { duration: attachment.duration } : {})}
        {...(attachment.waveform ? { waveform: attachment.waveform } : {})}
        {...(onRemove ? { onRemove } : {})}
      />
    ),
  },
];
const renderers: ContributionReader<AttachmentRenderer> = {
  snapshot: () => voiceEntries,
  subscribe: () => () => {},
};
const emptyEntries: readonly never[] = [];
const emptyReader = { snapshot: () => emptyEntries, subscribe: () => () => {} };
const samples = [...files, ...mediaSamples];
const archive = files[0];

function Draft({
  initial,
  disabled = false,
}: {
  initial: DraftAttachment[];
  disabled?: boolean;
}) {
  const [items, setItems] = useState(initial);
  return (
    <div className="draft-example">
      <div className={messageStyles.composer}>
        <div className={messageStyles.composerContent}>
          <ComposerAttachments
            items={items}
            media={media}
            renderers={renderers}
            disabled={disabled}
            remove={(id) => setItems((xs) => xs.filter((x) => x.id !== id))}
            retry={(id) =>
              setItems((xs) =>
                xs.map((x) =>
                  x.id === id ? { ...x, status: "ready", error: undefined } : x,
                ),
              )
            }
          />
          <p className="text-body text-metadata">Reply in thread</p>
        </div>
      </div>
      {!items.length && (
        <Button size="sm" onClick={() => setItems(initial)}>
          Restore attachment
        </Button>
      )}
    </div>
  );
}

function Sent({
  sample,
  unavailable = false,
  outgoing,
}: {
  sample: Sample;
  unavailable?: boolean;
  outgoing: boolean;
}) {
  const [notice, setNotice] = useState("");
  // MessageRow requires a broker/native source for inline audio. These local
  // samples exercise the same players directly without a live media endpoint.
  if (sample.attachment.kind === "audio" && !unavailable && sample.source) {
    return sample.attachment.voiceNote ? (
      <VoiceNoteCard
        source={sample.source}
        duration={2}
        waveform={sample.attachment.waveform ?? []}
      />
    ) : (
      <AudioAttachment attachment={sample.attachment} source={sample.source} />
    );
  }
  return (
    <>
      <MessageRow
        row={{
          id: sample.label,
          channelId: "playground",
          authorId: outgoing ? "reader" : "teammate",
          createdAt: 1790000000,
          content: "",
          attachments: [sample.attachment],
          mentions: [],
          reactions: [],
          participants: [],
          replyCount: 0,
        }}
        alignViewer
        viewer="reader"
        profile={{ name: outgoing ? "You" : "Sam" }}
        day={false}
        retry={undefined}
        extensions={{
          attachments: renderers,
          tools: emptyReader,
          inline: emptyReader,
        }}
        media={unavailable ? () => undefined : media}
        onOpenLink={() => {
          setNotice("Local specimen — no external file opened.");
          return true;
        }}
      />
      {notice && (
        <p role="status" className="text-caption text-subtle">
          {notice}
        </p>
      )}
    </>
  );
}

function Specimens() {
  useKeyboardFocusVisibility();
  const [revision, reset] = useState(0);
  const group = params.get("group") ?? "all";
  const outgoing = params.get("direction") !== "received";
  return (
    <main className="specimens">
      <div className="sample-heading">
        <h1 className="text-label">
          {parseAccent(params.get("accent"))} · {mode}
        </h1>
        <Button size="sm" onClick={() => reset((x) => x + 1)}>
          Reset samples
        </Button>
      </div>
      <div key={revision} className="sample-list">
        {(group === "all" || group === "composer") && (
          <section aria-label="Composer attachments">
            <h2 className="text-label">Composer</h2>
            {samples.map((sample) => (
              <article key={sample.label}>
                <h3 className="text-body-sm text-subtle">{sample.label}</h3>
                <Draft initial={[draft(sample)]} />
              </article>
            ))}
            <article>
              <h3 className="text-body-sm text-subtle">Media-only strip</h3>
              <Draft initial={mediaSamples.slice(0, 5).map((s) => draft(s))} />
            </article>
            <article>
              <h3 className="text-body-sm text-subtle">
                Mixed strip · compact media
              </h3>
              <Draft
                initial={[
                  draft(archive),
                  ...mediaSamples.slice(0, 5).map((s) => draft(s)),
                ]}
              />
            </article>
          </section>
        )}
        {(group === "all" || group === "messages") && (
          <section aria-label="Message attachments">
            <h2 className="text-label">
              {outgoing ? "Sent" : "Received"} messages
            </h2>
            {samples.map((sample) => (
              <article key={sample.label}>
                <h3 className="text-body-sm text-subtle">{sample.label}</h3>
                <Sent sample={sample} outgoing={outgoing} />
              </article>
            ))}
          </section>
        )}
        {(group === "all" || group === "states") && (
          <section aria-label="Attachment states">
            <h2 className="text-label">States</h2>
            {(
              ["queued", "preparing", "uploading", "ready", "error"] as const
            ).map((status) => (
              <article key={status}>
                <h3 className="text-body-sm text-subtle">{status}</h3>
                <Draft initial={[draft(archive, status)]} />
              </article>
            ))}
            <article>
              <h3 className="text-body-sm text-subtle">Disabled composer</h3>
              <Draft initial={[draft(archive)]} disabled />
            </article>
            {[archive, ...mediaSamples].map((sample) => (
              <article key={sample.label}>
                <h3 className="text-body-sm text-subtle">
                  Unavailable · {sample.label}
                </h3>
                <Sent sample={sample} unavailable outgoing={outgoing} />
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function Choice({
  label,
  value,
  values,
  change,
}: {
  label: string;
  value: string;
  values: readonly string[];
  change(value: string): void;
}) {
  return (
    <Select
      label={label}
      value={value}
      onValueChange={change}
      groups={[
        { label, options: values.map((value) => ({ value, label: value })) },
      ]}
    />
  );
}
function Playground() {
  useKeyboardFocusVisibility();
  const [accent, setAccent] = useState("citrus");
  const [contrast, setContrast] = useState("low");
  const [group, setGroup] = useState("all");
  const [width, setWidth] = useState("wide");
  const [scale, setScale] = useState("100%");
  const [direction, setDirection] = useState("sent");
  const accents = accent === "all" ? ACCENTS : [accent];
  return (
    <FullPageSurface>
      <PanelHeader title={<PanelHeaderLabel title="Attachment playground" />} />
      <div className="playground-body">
        <p className="text-body text-subtle">
          Real Buzz components with local samples. Preview, play, remove, and
          retry; reset to start again. Appearance changes stay in this
          playground.
        </p>
        <div className="controls">
          <Choice
            label="Accent"
            value={accent}
            values={["all", ...ACCENTS]}
            change={setAccent}
          />
          <Choice
            label="Contrast"
            value={contrast}
            values={["low", "high"]}
            change={setContrast}
          />
          <Choice
            label="Show"
            value={group}
            values={["all", "composer", "messages", "states"]}
            change={setGroup}
          />
          <Choice
            label="Width"
            value={width}
            values={["wide", "narrow"]}
            change={setWidth}
          />
          <Choice
            label="Text size"
            value={scale}
            values={["100%", "200%"]}
            change={setScale}
          />
          <Choice
            label="Messages"
            value={direction}
            values={["sent", "received"]}
            change={setDirection}
          />
        </div>
        <p className="text-caption text-subtle">
          PDF, spreadsheet, archive, code, text, document, presentation, unknown
          files; still and animated images; video, audio, voice notes. Upload
          states are simulated. Click images and media for expanded views.
        </p>
        <div className="theme-grid" data-width={width}>
          {accents.flatMap((a) =>
            (["light", "dark"] as const).map((m) => {
              const query = new URLSearchParams({
                frame: "1",
                accent: a,
                mode: m,
                contrast,
                group,
                scale: scale === "200%" ? "2" : "1",
                direction,
              });
              return (
                <section className="theme-frame" key={`${a}-${m}`}>
                  <h2 className="text-label">
                    {a} · {m}
                  </h2>
                  <iframe
                    title={`${a} ${m} attachment samples`}
                    src={`?${query}`}
                    loading="lazy"
                  />
                </section>
              );
            }),
          )}
        </div>
      </div>
    </FullPageSurface>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
const reactRoot = createRoot(root);
if (import.meta.hot) import.meta.hot.dispose(() => reactRoot.unmount());
reactRoot.render(
  <StrictMode>
    <ToastProvider>
      {params.has("frame") ? <Specimens /> : <Playground />}
    </ToastProvider>
  </StrictMode>,
);
