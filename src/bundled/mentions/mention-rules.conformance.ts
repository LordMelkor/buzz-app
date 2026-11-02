import { readFileSync } from "node:fs";
import type { MentionChoice } from "./mention-ranking";

/** Test-only reader for the portable mention-rules fixtures (see README.md). */
export type FixtureChoice = {
  pubkey: string;
  name: string;
  label?: string;
  aliases?: string[];
  member: boolean;
  agent?: boolean;
  elsewhere?: string;
  owned?: boolean;
  managed?: boolean;
};
export type MentionConformance = {
  version: number;
  matching: {
    name: string;
    label: string;
    query: string;
    expected: 0 | 1 | 2 | 3 | null;
  }[];
  ranking: {
    name: string;
    query: string;
    choices: FixtureChoice[];
    history?: Record<string, number>;
    presence?: Record<string, string>;
    expected: string[];
  }[];
  space: {
    name: string;
    query: string;
    choices: FixtureChoice[];
    expected: string | null;
  }[];
  query: {
    name: string;
    text: string;
    caret: number;
    expected: { start: number; end: number; query: string } | null;
  }[];
  admission: {
    name: string;
    query: string;
    names: string[];
    expected: boolean;
  }[];
  tags: {
    write: {
      name: string;
      members: string[];
      recipients: string[];
      references: string[];
      expected:
        | { tags: string[][] }
        | { error: "not_member" | "invalid" | "too_many" };
    }[];
    read: {
      name: string;
      tags: string[][];
      expected: { mentions: string[]; references: string[] };
    }[];
  };
};

export const mentionConformance = JSON.parse(
  readFileSync(
    new URL("./mention-rules.fixtures.json", import.meta.url),
    "utf8",
  ),
) as MentionConformance;

export function fixtureChoice(choice: FixtureChoice): MentionChoice {
  return {
    recipient: { pubkey: choice.pubkey, name: choice.name },
    label: choice.label ?? choice.name,
    aliases: choice.aliases ?? [choice.name],
    member: choice.member,
    agent: !!choice.agent,
    ...(choice.elsewhere ? { elsewhere: choice.elsewhere } : {}),
    owned: !!choice.owned,
    managed: !!choice.managed,
  };
}
