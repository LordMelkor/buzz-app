// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { references, type Directory } from "./references";

const ana = "a".repeat(64);
const bot = "b".repeat(64);
const twin = "c".repeat(64);
const directory: Directory = {
  profiles: {
    snapshot: () =>
      new Map([
        [ana, { name: "Ana" }],
        [bot, { name: "Scout" }],
        [twin, { name: "Ana" }],
      ]),
  },
  agentLibrary: {
    snapshot: () => ({
      identities: [
        { pubkey: bot, name: "Scout" },
        { pubkey: bot, name: "Scout Bot" },
      ],
    }),
  },
  channels: {
    list: () => ({
      channels: [
        { id: "1", name: "forecasting" },
        { id: "2", name: "old", archived: true },
      ],
    }),
    openDirectory: () => [
      { id: "3", name: "forecasting" },
      { id: "4", name: "lab" },
      { id: "5", name: "old" },
    ],
  },
};
const message = (
  content: string,
  mentions: string[],
  edited?: true,
  attachmentSeams?: number[],
) => ({
  content,
  mentions,
  ...(edited ? { edited } : {}),
  ...(attachmentSeams ? { attachmentSeams } : {}),
});

// What the host can bind (profileMentionParts, the reference directory's `named` list).
describe("reference context for prose", () => {
  it("names each signed recipient by its profile and agent names, once per identity", () => {
    expect(
      references(message("@Scout Bot hi", [bot, "not-a-key"]), directory).names,
    ).toEqual(["Scout", "Scout Bot"]);
  });

  it("repeats a name two recipients share, so the engine sees it as ambiguous", () => {
    expect(references(message("@Ana", [ana, twin]), directory).names).toEqual([
      "Ana",
      "Ana",
    ]);
  });

  // Removing an attachment can join text into a name; the host never binds
  // across that seam, so the name stays text and its paragraph stays raw.
  it("drops a name that an attachment seam runs through", () => {
    expect(
      references(message("@Ana: $$", [ana, bot], undefined, [2]), directory)
        .names,
    ).toEqual(["Scout", "Scout Bot"]);
    expect(
      references(message("@Ana: $$", [ana], undefined, [4]), directory).names,
    ).toEqual(["Ana"]);
  });

  // MessageMarkdown leaves link-repaired attachment prose unbound, and the
  // repaired body is all a plugin sees; a message without a link still binds.
  it("names no one in an attachment message with a link, which may be a repaired one the host leaves unbound", () => {
    expect(
      references(message("[a](x) @Ana $$", [ana], undefined, []), directory)
        .names,
    ).toEqual([]);
    expect(
      references(message("@Ana $$", [ana], undefined, []), directory).names,
    ).toEqual(["Ana"]);
  });

  it("names no one in an edited body, which the host never binds", () => {
    expect(references(message("@Ana", [ana], true), directory).names).toEqual(
      [],
    );
  });

  it("offers live channels the text names: joined first, then open ones no joined channel shadows", () => {
    // The joined `old` is archived, so the open channel of that name links instead.
    expect(
      references(message("#forecasting #lab #old #missing", []), directory)
        .channels,
    ).toEqual(["forecasting", "lab", "old"]);
  });

  // The host binds channel names in decoded text, so `&#35;lab` links too.
  it("offers channels the text names through character references", () => {
    expect(
      references(message("&#35;lab #fore&#99;asting", []), directory).channels,
    ).toEqual(["forecasting", "lab"]);
  });

  it("reads nothing without a directory, so an unknown name leaves its paragraph as text", () => {
    expect(references(message("@Ana #lab", [ana]), undefined)).toEqual({
      names: [],
      channels: [],
      emoji: [],
    });
  });
});
