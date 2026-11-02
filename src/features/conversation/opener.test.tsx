// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Attachment } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { AttachmentView } from "./AttachmentView";
import { ComposerTools } from "./ComposerTools";
import type {
  AttachmentRenderer,
  ComposerTool,
  ContributionReader,
} from "./contracts";
import { TargetOpenerProvider } from "./opener";

afterEach(cleanup);

const reader = <T,>(entries: readonly T[]): ContributionReader<T> => ({
  snapshot: () => entries as never,
  subscribe: () => () => {},
});
const tool = {
  id: "work",
  title: "Work",
  key: "test.plugin/work",
  pluginId: "test.plugin",
  revision: "one",
  component: ({ open }: { open(target: string): boolean }) => (
    <button type="button" onClick={() => open("panel:tool")}>
      Tool open
    </button>
  ),
};
const attachmentRenderer = {
  id: "file",
  title: "File",
  key: "test.plugin/file",
  pluginId: "test.plugin",
  revision: "one",
  matches: () => true,
  component: ({ open }: { open(target: string): boolean }) => (
    <button type="button" onClick={() => open("panel:file")}>
      Attachment open
    </button>
  ),
};
function Surfaces() {
  return (
    <>
      <ComposerTools
        registry={reader<ComposerTool>([tool])}
        session={{} as RelaySession}
        scope="scope"
        channelId="channel"
        disabled={false}
        recipients={[]}
        insertText={() => false}
        insertMention={() => false}
        insertMentions={() => false}
        replaceRecipients={() => false}
        insertResource={() => "no"}
        focus={() => {}}
      />
      <AttachmentView
        registry={reader<AttachmentRenderer>([attachmentRenderer])}
        attachment={{ url: "https://example.com/a.txt" } as Attachment}
        source="https://example.com/a.txt"
        fallback={null}
      />
    </>
  );
}

it("routes composer tools and attachment renderers to the conversation host", () => {
  const open = vi.fn(() => true);
  render(
    <TargetOpenerProvider canOpen={() => true} open={open}>
      <Surfaces />
    </TargetOpenerProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Tool open" }));
  expect(open).toHaveBeenLastCalledWith("panel:tool");
  fireEvent.click(screen.getByRole("button", { name: "Attachment open" }));
  expect(open).toHaveBeenLastCalledWith("panel:file");
});

it("opens nothing outside a conversation host", () => {
  let result: boolean | undefined;
  const probe = {
    ...attachmentRenderer,
    component: ({ open }: { open(target: string): boolean }) => (
      <button
        type="button"
        onClick={() => {
          result = open("panel:file");
        }}
      >
        Probe
      </button>
    ),
  };
  render(
    <AttachmentView
      registry={reader<AttachmentRenderer>([probe])}
      attachment={{ url: "https://example.com/a.txt" } as Attachment}
      source="https://example.com/a.txt"
      fallback={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Probe" }));
  expect(result).toBe(false);
});

it("shows availability from the host's current render", () => {
  const probe = {
    ...attachmentRenderer,
    component: ({ canOpen }: { canOpen(target: string): boolean }) => (
      <button type="button" disabled={!canOpen("panel:file")}>
        Probe
      </button>
    ),
  };
  const registry = reader<AttachmentRenderer>([probe]);
  const view = (available: boolean) => (
    <TargetOpenerProvider canOpen={() => available} open={() => true}>
      <AttachmentView
        registry={registry}
        attachment={{ url: "https://example.com/a.txt" } as Attachment}
        source="https://example.com/a.txt"
        fallback={null}
      />
    </TargetOpenerProvider>
  );
  const { rerender } = render(view(false));
  expect(screen.getByRole("button", { name: "Probe" })).toBeDisabled();
  rerender(view(true));
  expect(screen.getByRole("button", { name: "Probe" })).toBeEnabled();
});
