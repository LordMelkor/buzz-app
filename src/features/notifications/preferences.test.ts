import { expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parsePreferences,
} from "./preferences";

const stored = {
  enabled: true,
  notifyWhileViewing: false,
  sound: true,
  categories: { mention: true, direct: true, thread: false },
};

it("values saved before per-category sounds restore with the defaults", () => {
  expect(parsePreferences(stored).sounds).toEqual(
    DEFAULT_NOTIFICATION_PREFERENCES.sounds,
  );
});

it.each([
  {
    mention: "ping",
    direct: "unison",
    thread: "doop",
    agent: "doodone",
    person: "soft",
  },
  {
    mention: "silent",
    direct: "silent",
    thread: "silent",
    agent: "silent",
    person: "silent",
  },
])(
  "saved sound choices round-trip and unknown names reject the payload: %j",
  (sounds) => {
    expect(
      parsePreferences(JSON.parse(JSON.stringify({ ...stored, sounds })))
        .sounds,
    ).toEqual(sounds);
    expect(() => parsePreferences({ ...stored, sounds: "ping" })).toThrow(
      "Invalid notification sounds",
    );
    expect(() =>
      parsePreferences({ ...stored, sounds: { mention: "klaxon" } }),
    ).toThrow("Invalid notification sounds");
  },
);

it("values saved before the people list restore with no one on it", () => {
  expect(parsePreferences(stored).people).toEqual([]);
});

it("the people list round-trips once per person and rejects anything but pubkeys", () => {
  const a = "a".repeat(64);
  expect(
    parsePreferences(
      JSON.parse(JSON.stringify({ ...stored, people: [a, a, "b".repeat(64)] })),
    ).people,
  ).toEqual([a, "b".repeat(64)]);
  for (const people of ["a", ["npub1x"], [a.toUpperCase()], Array(201).fill(a)])
    expect(() => parsePreferences({ ...stored, people })).toThrow(
      "Invalid notification people",
    );
});
