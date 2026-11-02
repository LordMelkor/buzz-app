// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useLayoutEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComposerFormat, ComposerInputElement } from "./composer-dom";
import { composerMarkdown } from "./composer-markdown";
import type { ComposerSession } from "./composer-session";
import {
  composerDOMFixture,
  longRichDraft,
  pasteRichDraft,
} from "./composer-testing";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { MessageMarkdown } from "./MessageMarkdown";
import { RichComposerInput } from "./RichComposerInput";
import type { CustomEmoji } from "../relay/emoji";
import { scanMarkdown } from "../relay/message-content";

// Pass-through spies: the real renderer and parser run; the test counts them.
vi.mock("./MessageMarkdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MessageMarkdown")>();
  return { ...actual, MessageMarkdown: vi.fn(actual.MessageMarkdown) };
});
vi.mock("../relay/message-content", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../relay/message-content")>();
  return { ...actual, scanMarkdown: vi.fn(actual.scanMarkdown) };
});

composerDOMFixture();
afterEach(cleanup);

function mount() {
  const ref = createRef<ComposerInputElement>();
  let draft = mentionDraft("");
  let commits = 0;
  const profiles = new Map();
  const channels = { status: "ready", channels: [] };
  // A catalog snapshot, as MessageComposer passes it.
  const emoji: readonly CustomEmoji[] = [];
  const session = {
    media: (url: string) => url,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
  } as unknown as ComposerSession;
  // Stands in for MessageComposer, which re-renders whenever the editor
  // reports a draft or a toolbar state.
  function Host() {
    const [value, setValue] = useState<MentionDraft>(draft);
    const [, setFormats] = useState<readonly ComposerFormat[]>([]);
    useLayoutEffect(() => {
      commits++;
    });
    return (
      <RichComposerInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Message"
        maxLength={16000}
        session={session}
        scope="scope"
        channelId="channel"
        extensions={undefined}
        emoji={emoji}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
        onFormatsChange={setFormats}
      />
    );
  }
  render(<Host />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  pasteRichDraft(input, longRichDraft());
  expect(input.querySelectorAll("[data-source]")).toHaveLength(45);
  expect(input.querySelectorAll("strong")).toHaveLength(9);
  expect(input.querySelectorAll("li")).toHaveLength(38);
  return {
    input,
    draft: () => draft,
    commits: () => commits,
    pasted: composerMarkdown(draft),
    /** Each chip's artwork, as its link label. */
    chips: () =>
      [...input.querySelectorAll<HTMLElement>("[data-source]")].map(
        (chip) => [chip.dataset.source, chip.textContent] as const,
      ),
  };
}

const label = (source = "") => source.match(/^\[(.*)\]\(/)?.[1];

it("types into a long rich draft without redrawing its link tokens or reparsing per pass", async () => {
  const h = mount();
  const text = h.draft().text;
  // Prose with later tokens, whose offsets every keystroke shifts.
  const middle = text.indexOf(" bravo", text.length / 2) + 1;
  act(() => h.input.setSelectionRange(middle, middle));
  const user = userEvent.setup();
  const renders = vi.mocked(MessageMarkdown);
  const parses = vi.mocked(scanMarkdown);
  // Whole-draft parses, not a token's own source.
  const draftParses = () =>
    parses.mock.calls.filter(([text]) => text.length > h.pasted.length / 2)
      .length;
  for (const key of "xyz") {
    renders.mockClear();
    parses.mockClear();
    const commits = h.commits();
    await user.keyboard(key);
    // One host commit per keystroke: an unchanged toolbar state re-renders
    // nothing, and unchanged tokens keep their artwork.
    expect(h.commits() - commits).toBe(1);
    expect(renders).not.toHaveBeenCalled();
    expect(draftParses()).toBe(1);
  }
  expect(h.input.querySelectorAll("[data-source]")).toHaveLength(45);
  expect(h.draft().text).toBe(
    `${text.slice(0, middle)}xyz${text.slice(middle)}`,
  );
  const sent = composerMarkdown(h.draft());
  expect(sent.split("xyz")).toHaveLength(2);
  expect(sent.replace("xyz", "")).toBe(h.pasted);
  act(() => h.input.undo(false));
  expect(composerMarkdown(h.draft())).toBe(h.pasted);
  expect(h.input.querySelectorAll("[data-source]")).toHaveLength(45);
});

it("deletes a chip without redrawing the chips after it, and restores it on undo", async () => {
  const h = mount();
  const chips = h.chips();
  const [first] = chips;
  if (!first?.[0]) throw new Error("No chip pasted");
  for (const [source, artwork] of chips) expect(artwork).toBe(label(source));
  const text = h.draft().text;
  const start = text.indexOf(first[0]);
  const end = start + first[0].length;
  act(() => h.input.setSelectionRange(start, end));
  const user = userEvent.setup();
  const renders = vi.mocked(MessageMarkdown);
  renders.mockClear();
  await user.keyboard("{Backspace}");
  // The first host leaves; every later host stays mounted with its artwork.
  expect(h.chips()).toEqual(chips.slice(1));
  expect(renders).not.toHaveBeenCalled();
  expect(h.draft().text).toBe(`${text.slice(0, start)}${text.slice(end)}`);
  renders.mockClear();
  act(() => h.input.undo(false));
  expect(h.chips()).toEqual(chips);
  expect(composerMarkdown(h.draft())).toBe(h.pasted);
  // Only the restored chip drew.
  expect(
    new Set(renders.mock.calls.map(([props]) => props.row.content)),
  ).toEqual(new Set([first[0]]));
});
