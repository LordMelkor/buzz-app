// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useLayoutEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComposerFormat, ComposerInputElement } from "./composer-dom";
import { composerMarkdown } from "./composer-markdown";
import type { ComposerSession } from "./composer-session";
import { composerDOMFixture } from "./composer-testing";
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

/** A long status update as Buzz copies it: nine bold section titles, each over
 * a list. Each of the 38 items opens with a pull request link; the last lists
 * eight. Placeholder prose only. */
function statusUpdate() {
  const words = "alpha bravo charlie delta echo foxtrot golf hotel".split(" ");
  const prose = (seed: number) =>
    Array.from(
      { length: 5 + (seed % 9) },
      (_, i) => words[(seed + i) % words.length],
    ).join(" ");
  const pull = (n: number, label = `#${n}`) =>
    `<a href="https://github.com/example/app/pull/${n}">${label}</a>`;
  let html = "";
  let n = 100;
  const sections = [3, 5, 4, 6, 3, 8, 4, 3, 2];
  sections.forEach((items, section) => {
    html += `<p><strong>Section title (${section + 1})</strong></p><ul>`;
    for (let item = 0; item < items; item++) {
      n += 7;
      if (section === sections.length - 1 && item === items - 1) {
        const pulls = Array.from({ length: 8 }, (_, i) => pull(n + i));
        html += `<li>${pulls.join(", ")}</li>`;
        continue;
      }
      const extra = [
        " ⚠️ check",
        " “quoted” isn’t",
        " ⌘K",
        " &lt;Name&gt; in #general",
      ][item % 4];
      html += `<li>${pull(n, item % 3 ? `#${n}` : `repo #${n}`)} ${prose(n)}${extra}</li>`;
    }
    html += "</ul>";
  });
  return `<div data-buzz-copy>${html}</div>`;
}

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
  return { input, draft: () => draft, commits: () => commits };
}

it("types into a long rich draft without redrawing its link tokens or reparsing per pass", async () => {
  const h = mount();
  act(() => {
    h.input.focus();
    fireEvent.paste(h.input, {
      clipboardData: {
        items: [],
        types: ["text/plain", "text/html"],
        getData: (type: string) =>
          type === "text/html" ? statusUpdate() : "copied text",
      },
    });
  });
  const tokens = h.input.querySelectorAll("[data-source]").length;
  expect(tokens).toBe(45);
  expect(h.input.querySelectorAll("strong")).toHaveLength(9);
  expect(h.input.querySelectorAll("li")).toHaveLength(38);
  const pasted = composerMarkdown(h.draft());
  const text = h.draft().text;
  // Prose with later tokens, whose offsets every keystroke shifts.
  const middle = text.indexOf(" bravo", text.length / 2) + 1;
  act(() => h.input.setSelectionRange(middle, middle));
  const user = userEvent.setup();
  const renders = vi.mocked(MessageMarkdown);
  const parses = vi.mocked(scanMarkdown);
  // Whole-draft parses, not a token's own source.
  const draftParses = () =>
    parses.mock.calls.filter(([text]) => text.length > pasted.length / 2)
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
  expect(h.input.querySelectorAll("[data-source]")).toHaveLength(tokens);
  expect(h.draft().text).toBe(
    `${text.slice(0, middle)}xyz${text.slice(middle)}`,
  );
  const sent = composerMarkdown(h.draft());
  expect(sent.split("xyz")).toHaveLength(2);
  expect(sent.replace("xyz", "")).toBe(pasted);
  act(() => h.input.undo(false));
  expect(composerMarkdown(h.draft())).toBe(pasted);
  expect(h.input.querySelectorAll("[data-source]")).toHaveLength(tokens);
});
