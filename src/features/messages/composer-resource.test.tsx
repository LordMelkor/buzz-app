// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { Schema } from "prosemirror-model";
import { afterEach, describe, expect, it } from "vitest";
import { EditableInput } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerMarkdown } from "./composer-markdown";
import {
  composerResource,
  composerSchema,
  readComposerDocument,
} from "./composer-document";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { scanMarkdown } from "../relay/message-content";
import { entityHref } from "../repos/routes";

composerDOMFixture();
afterEach(cleanup);

const uri = entityHref({
  type: "issue",
  owner: "a".repeat(64),
  dtag: "game",
  id: "b".repeat(64),
});
const fix = { uri, label: "Fix login" };

function mount(initial: MentionDraft | string = "", maxLength = 16000) {
  const ref = createRef<ComposerInputElement>();
  let draft = mentionDraft(initial);
  function Editor() {
    const [value, setValue] = useState(draft);
    return (
      <EditableInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Draft"
        maxLength={maxLength}
        decorationsFor={() => []}
        onFormatsChange={() => {}}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
      />
    );
  }
  const view = render(<Editor />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  const end = input.value.length;
  act(() => {
    input.focus();
    input.setSelectionRange(end, end);
  });
  return {
    input,
    view,
    user: userEvent.setup(),
    markdown: () => composerMarkdown(draft),
    draft: () => draft,
    insert: (value = fix) => {
      let result = "" as true | string;
      act(() => {
        result = input.insertResource(value);
      });
      return result;
    },
  };
}
const links = (markdown: string) =>
  scanMarkdown(markdown).links.map((link) => link.url);

describe("composer resources", () => {
  it("sends exactly an escaped Markdown link and renders a host-owned label", () => {
    const h = mount("See ");
    expect(h.insert()).toBe(true);
    expect(h.markdown()).toBe(`See [Fix login](${uri}) `);
    const token = h.input.querySelector("[data-source]");
    expect(token).toHaveTextContent("Resource: Fix login");
    expect(document.activeElement).toBe(h.input);
  });

  it("neutralizes hostile labels and rejects unsafe or rewritten URIs", () => {
    const label =
      "a`b` *c* _d_ ~e~ [f](javascript:x) <g> &amp; | \\ \n\u202eh\u0007 !";
    const value = composerResource({ uri, label });
    expect(value?.resource.label).toBe(
      "a`b` *c* _d_ ~e~ [f](javascript:x) <g> &amp; | \\ h !",
    );
    const h = mount("x ");
    expect(h.insert({ uri, label })).toBe(true);
    const markdown = `${h.markdown()} trailing \` [late](${uri})`;
    expect(links(markdown)).toEqual([uri, uri]);
    expect(scanMarkdown(markdown).tree.children?.[0]?.children?.[1]).toEqual(
      expect.objectContaining({
        type: "link",
        url: uri,
        children: [expect.objectContaining({ value: value?.resource.label })],
      }),
    );
    // Code points, not UTF-16 units: a surrogate pair is never split.
    const long = composerResource({ uri, label: `${"a".repeat(119)}😀z` });
    expect(long?.resource.label).toBe(`${"a".repeat(119)}😀`);
    for (const bad of [
      "javascript:alert(1)",
      "https://example.com/a b",
      "https://example.com/)",
      " https://example.com",
      "",
    ])
      expect(composerResource({ uri: bad, label: "x" })).toBeUndefined();
    expect(composerResource({ uri, label: " \u202e\n " })).toBeUndefined();
    expect(h.insert({ uri: "javascript:alert(1)", label: "x" })).toBe(
      "This link can't be added",
    );
  });

  it("separates a preceding ! or \\ so the link is not an image or escape", () => {
    for (const prefix of ["!", "\\"]) {
      const h = mount(prefix);
      expect(h.insert()).toBe(true);
      expect(h.markdown()).toBe(`${prefix} [Fix login](${uri}) `);
      expect(links(h.markdown())).toEqual([uri]);
      cleanup();
    }
  });

  it("rejects code contexts, the resource limit, and serialized length", async () => {
    const h = mount();
    act(() => h.input.toggleFormat("code"));
    await h.user.keyboard("abc");
    expect(h.insert()).toBe("Links can't be added inside code");
    cleanup();
    // Raw Markdown source that would swallow the link is also refused.
    const raw = mount("`code`");
    act(() => raw.input.setSelectionRange(3, 3));
    expect(raw.insert()).toBe(
      "Links can't be added inside code or other Markdown here",
    );
    cleanup();
    const many = mount();
    for (let i = 0; i < 32; i++) expect(many.insert()).toBe(true);
    expect(many.insert()).toBe("Add at most 32 links to one message");
    cleanup();
    // The label is short, but the serialized link is not.
    const source = composerResource(fix)?.source ?? "";
    const short = mount("", source.length);
    expect(short.insert()).toBe("Message is too long to add this link");
    expect(short.markdown()).toBe("");
  });

  it("keeps the link through later formatting, and code makes it literal text", () => {
    const h = mount("a ");
    h.insert();
    act(() => {
      h.input.setSelectionRange(0, h.input.value.length);
      h.input.toggleFormat("bold");
    });
    expect(links(h.markdown())).toEqual([uri]);
    expect(h.markdown()).toMatch(/^\*\*a \[Fix login\]\(.+\)\*\*/);
    // Link editing cannot nest a destination around the resource.
    expect(h.input.editLink()).toBeNull();
    act(() => h.input.toggleFormat("code"));
    expect(links(h.markdown())).toEqual([]);
    expect(h.draft().document).toBeDefined();
    const restored = readComposerDocument(h.draft(), []);
    let resources = 0;
    restored.descendants((node) => {
      if (node.attrs.resource) resources++;
    });
    expect(resources).toBe(0);
  });

  it("never splits or breaks an existing link, but may follow one", () => {
    const raw = "[docs](https://example.com)";
    const h = mount(raw);
    for (const [start, end] of [
      [2, 2],
      [2, 10],
    ] as const) {
      act(() => h.input.setSelectionRange(start, end));
      expect(h.insert()).toBe("Links can't be added inside another link");
      expect(h.markdown()).toBe(raw);
    }
    cleanup();
    const marked = mount("docs");
    act(() => {
      marked.input.setSelectionRange(0, 4);
      marked.input.editLink()?.save("docs", "https://example.com");
      marked.input.setSelectionRange(2, 2);
    });
    const linked = marked.markdown();
    expect(links(linked)).toEqual(["https://example.com/"]);
    expect(marked.insert()).toBe("Links can't be added inside another link");
    expect(marked.markdown()).toBe(linked);
    act(() => marked.input.setSelectionRange(4, 4));
    expect(marked.insert()).toBe(true);
    expect(links(marked.markdown())).toEqual(["https://example.com/", uri]);
  });

  it("demotes a resource that adjacent edits or restore would not send as its link", async () => {
    const resources = (h: ReturnType<typeof mount>) =>
      [...h.input.querySelectorAll("[data-source]")].filter((node) =>
        node.textContent?.startsWith("Resource: "),
      ).length;
    const h = mount("x");
    h.insert();
    const sent = h.markdown();
    for (const [prefix, suffix] of [
      ["!", ""],
      ["`", "`"],
    ] as const) {
      act(() => h.input.setSelectionRange(1, 1));
      await h.user.keyboard(prefix);
      if (suffix) {
        // A lone backtick is literal text, so the link still sends as itself.
        expect(resources(h)).toBe(1);
        expect(links(h.markdown())).toEqual([uri]);
        act(() =>
          h.input.setSelectionRange(h.input.value.length, h.input.value.length),
        );
        await h.user.keyboard(suffix);
      }
      // What remains visible is the ordinary text that will be sent.
      const literal = `x${prefix}[Fix login](${uri}) ${suffix}`;
      expect(h.markdown()).toBe(literal);
      expect(resources(h)).toBe(0);
      expect(links(h.markdown())).toEqual([]);
      if (suffix) {
        // The closing backtick demotes the resource in its own history event
        // and then converts the span to code in a separate one. The first undo
        // restores the literal source, closing backtick included, where the
        // resource still would not send as its link; the next removes that
        // backtick together with the demotion it caused.
        expect(h.input.querySelector("code")).toHaveTextContent(
          `[Fix login](${uri})`,
        );
        act(() => h.input.undo(false));
        expect(h.input.querySelector("code")).toBeNull();
        expect(h.markdown()).toBe(literal);
        expect(resources(h)).toBe(0);
        expect(links(h.markdown())).toEqual([]);
        act(() => h.input.undo(false));
        expect(h.markdown()).toBe(`x${prefix}[Fix login](${uri}) `);
        expect(resources(h)).toBe(1);
        expect(links(h.markdown())).toEqual([uri]);
      }
      act(() => h.input.undo(false));
      expect(h.markdown()).toBe(sent);
      expect(resources(h)).toBe(1);
    }
    const saved = JSON.parse(JSON.stringify(h.draft()));
    const paragraph = saved.document.content.content[0];
    paragraph.content[0].text = "x!";
    cleanup();
    const restored = mount(saved);
    expect(resources(restored)).toBe(0);
    expect(restored.markdown()).toBe(`x![Fix login](${uri}) `);
  });

  it("deletes, undoes, redoes and copies the whole atom", async () => {
    const h = mount("x ");
    h.insert();
    const markdown = h.markdown();
    // One Backspace removes the trailing space, the next the whole atom.
    await h.user.keyboard("{Backspace}{Backspace}");
    expect(h.markdown()).toBe("x ");
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe(markdown.trimEnd());
    act(() => h.input.undo(true));
    expect(h.markdown()).toBe("x ");
    act(() => h.input.undo(false));
    await h.user.keyboard("{ArrowLeft}{Delete}");
    expect(h.markdown()).toBe("x ");
    act(() => h.input.undo(false));
    act(() => h.input.setSelectionRange(0, h.input.value.length));
    const data = new Map<string, string>();
    fireEvent.copy(h.input, {
      clipboardData: {
        setData: (type: string, text: string) => data.set(type, text),
      },
    });
    expect(data.get("text/plain")).toBe(markdown.trimEnd());
  });

  it("restores the host atom without the provider, and rejects tampered snapshots", () => {
    const h = mount("x ");
    h.insert();
    const saved = JSON.parse(JSON.stringify(h.draft()));
    cleanup();
    // decorationsFor is empty: rendering never depends on the providing plugin.
    const restored = mount(saved);
    expect(restored.markdown()).toBe(composerMarkdown(mentionDraft(saved)));
    expect(restored.input.querySelector("[data-source]")).toHaveTextContent(
      "Resource: Fix login",
    );
    cleanup();
    const tampered = JSON.parse(
      JSON.stringify(saved).replace('"label":"Fix login"', '"label":"Pay me"'),
    );
    const doc = readComposerDocument(mentionDraft(tampered), []);
    doc.descendants((node) => {
      if (node.type.name === "token") expect(node.attrs.resource).toBeNull();
    });
  });

  it("downgrades on the previous schema to an ordinary token with formatting", () => {
    const h = mount("a ");
    h.insert();
    act(() => {
      h.input.setSelectionRange(0, h.input.value.length);
      h.input.toggleFormat("bold");
    });
    const document = JSON.parse(JSON.stringify(h.draft().document));
    const spec = composerSchema.spec;
    const token = spec.nodes.get("token");
    if (!token?.attrs) throw new Error("token spec missing");
    const { resource: _resource, ...attrs } = token.attrs;
    const old = new Schema({
      nodes: spec.nodes.update("token", { ...token, attrs }),
      marks: spec.marks,
    });
    const node = old.nodeFromJSON(document.content);
    node.check();
    let found = false;
    node.descendants((child) => {
      if (child.type.name !== "token") return;
      found = true;
      expect(child.attrs).not.toHaveProperty("resource");
      expect(child.attrs.source).toBe(`[Fix login](${uri})`);
      expect(child.marks.map((mark) => mark.type.name)).toContain("bold");
    });
    expect(found).toBe(true);
  });
});
