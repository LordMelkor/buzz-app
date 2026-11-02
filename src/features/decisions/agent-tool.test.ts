import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { flush } from "../relay/testing";
import { AGENT_CALL_LIMIT, registerDecideTool } from "./agent-tool";
import {
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionRequest,
  DecisionsService,
} from "./service";

const AGENT = "a".repeat(64);
const PROVIDER = "buzz.typesafe/typesafe";

/** Some answer of each question's own type. */
function answerAll(request: DecisionRequest) {
  return Object.fromEntries(
    Object.entries(request.questions).map(
      ([name, question]): [string, DecisionAnswer] => [
        name,
        question.type === "yes_no"
          ? { type: "yes_no", probability: 0.5 }
          : question.type === "choice"
            ? {
                type: "choice",
                choice: Object.keys(question.options)[0] ?? "",
                confidence: 0.5,
                probabilities: {},
              }
            : { type: "score", score: 0, confidence: 0.5, probabilities: {} },
      ],
    ),
  );
}

/** The tool over a real `DecisionsService`; `provider` (none when null) is
 * registered by TypeSafe's plugin, so the service picks it. */
async function setup(
  provider: DecisionProvider["decide"] | null = async (request) => ({
    outcome: "answered",
    model: "jev-1.13.0",
    answers: answerAll(request),
  }),
) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const storage = { getItem: () => null, setItem() {} } as unknown as Storage;
  const service = new DecisionsService(root, storage, () => () => {});
  const decide = vi.fn<DecisionProvider["decide"]>(
    provider ?? (() => Promise.reject(new Error("not registered"))),
  );
  if (provider) {
    await root
      .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
      .plugin((ctx) =>
        ctx.decisions.registerProvider({
          id: "typesafe",
          label: "Fake",
          description: "A test provider.",
          status: () => "ready",
          subscribe: () => () => {},
          decide,
        }),
      )
      .await();
    await flush();
  }
  const addTool = vi.fn<(tool: AddedTool) => void>();
  registerDecideTool(
    {
      addTool,
      snapshot: () => ({
        running: [{ key: AGENT, relay: "wss://relay.example.com" }],
      }),
    },
    service,
  );
  const tool = addTool.mock.calls[0]?.[0];
  if (!tool) throw new Error("the tool was not added");
  const call = async (args: Record<string, unknown>, key = AGENT) =>
    JSON.parse(String(await tool.call({ key } as BuzzClient, {}, args)));
  /** What the provider was last asked, as the service passed it on. */
  const asked = () => decide.mock.lastCall?.[0];
  return { tool, decide, call, asked };
}

it("asks in System One's format as the agent's community, and answers in it", async () => {
  const { tool, call, asked } = await setup(async (request) => ({
    outcome: "answered",
    model: "jev-1.13.0",
    // The service drops answers to questions not asked.
    answers: {
      ...answerAll(request),
      billing: { type: "yes_no", probability: 0.9 },
      tone: {
        type: "choice",
        choice: "calm",
        confidence: 0.7,
        probabilities: { angry: 0.2, calm: 0.8 },
      },
      urgency: {
        type: "score",
        score: 1.7,
        confidence: 0.55,
        probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
      },
    },
  }));
  expect(tool.name).toBe("decisions_ask");
  const reply = await call({
    state: { message: "I was charged twice." },
    questions: {
      billing: {
        type: "noul",
        instructions: "Is this about billing?",
        criteria: { true: "Money or charges", false: "Anything else" },
      },
      tone: {
        type: "choice",
        instructions: { task: "Pick the tone." },
        criteria: { angry: "Upset", calm: null },
      },
      urgency: {
        type: "score",
        instructions: "How urgent?",
        criteria: ["Can wait", "This week", "Today"],
      },
    },
  });
  expect(asked()).toEqual({
    state: '{"message":"I was charged twice."}',
    community: "wss://relay.example.com",
    timeoutMs: 30_000,
    questions: {
      billing: {
        type: "yes_no",
        instructions:
          "Is this about billing?\nYes means: Money or charges\nNo means: Anything else",
      },
      tone: {
        type: "choice",
        instructions: '{"task":"Pick the tone."}',
        options: { angry: "Upset", calm: "" },
      },
      urgency: {
        type: "score",
        instructions: "How urgent?",
        levels: ["Can wait", "This week", "Today"],
      },
    },
  });
  expect(reply).toEqual({
    model: "jev-1.13.0",
    provider: PROVIDER,
    answers: {
      billing: { type: "noul", noul: 0.9 },
      tone: {
        type: "choice",
        choice: "calm",
        confidence: 0.7,
        probabilities: { angry: 0.2, calm: 0.8 },
      },
      urgency: {
        type: "score",
        score: 1.7,
        confidence: 0.55,
        probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
        legend: { "0": "Can wait", "1": "This week", "2": "Today" },
      },
    },
  });
  // An agent that does not run here sends no community.
  await call(
    { state: "hi", questions: { spam: { type: "noul", instructions: "?" } } },
    "b".repeat(64),
  );
  expect(asked()).not.toHaveProperty("community");
});

it("tells the agent why a decision failed and what fixes it", async () => {
  const none = await setup(null);
  const spam = { spam: { type: "noul", instructions: "Spam?" } };
  await expect(none.call({ state: "hi", questions: spam })).rejects.toThrow(
    /Settings > Decisions API.*\(unavailable\)/,
  );
  // An answer that does not fit the questions is refused by the service.
  const odd = await setup(async () => ({
    outcome: "answered",
    model: "jev-1.13.0",
    answers: {
      spam: { type: "score", score: 1, confidence: 1, probabilities: {} },
    },
  }));
  await expect(odd.call({ state: "hi", questions: spam })).rejects.toThrow(
    "(invalid_response)",
  );
});

it("keeps agents to a few calls in flight on the device", async () => {
  const release: (() => void)[] = [];
  const { call, decide } = await setup(
    (request) =>
      new Promise((resolve) =>
        release.push(() =>
          resolve({
            outcome: "answered",
            model: "jev-1.13.0",
            answers: answerAll(request),
          }),
        ),
      ),
  );
  const args = {
    state: "hi",
    questions: { spam: { type: "noul", instructions: "Spam?" } },
  };
  const waiting = Array.from({ length: AGENT_CALL_LIMIT }, (_, i) =>
    call(args, String(i).repeat(64)),
  );
  await flush();
  await expect(call(args)).rejects.toThrow("(busy)");
  expect(decide).toHaveBeenCalledTimes(AGENT_CALL_LIMIT);
  for (const done of release.splice(0)) done();
  await Promise.all(waiting);
  // A finished call frees its place.
  const next = call(args);
  await flush();
  release.splice(0)[0]?.();
  await expect(next).resolves.toMatchObject({ provider: PROVIDER });
});

it.each([
  ["a box question", { type: "box", instructions: "Find it." }, "type must be"],
  [
    "a choice listed as an array",
    { type: "choice", instructions: "Tone?", criteria: ["a", "b"] },
    "criteria maps each choice",
  ],
  [
    "a score with no levels",
    { type: "score", instructions: "Level?" },
    "criteria lists its levels",
  ],
  [
    "noul criteria that is not an object",
    { type: "noul", instructions: "Spam?", criteria: "Ads" },
    'a noul\'s criteria is {"true"',
  ],
  [
    "noul criteria with other keys",
    { type: "noul", instructions: "Spam?", criteria: { yes: "Ads" } },
    'a noul\'s criteria is {"true"',
  ],
  [
    "no instructions",
    { type: "score", criteria: ["a", "b"] },
    "needs instructions",
  ],
  [
    "a noul with nothing to ask",
    { type: "noul", criteria: {} },
    "needs instructions",
  ],
])("refuses %s before asking", async (_, question, error) => {
  const { call, decide } = await setup();
  await expect(
    call({ state: "hi", questions: { q: question } }),
  ).rejects.toThrow(error);
  expect(decide).not.toHaveBeenCalled();
});

it("refuses questions that are not a map", async () => {
  const { call, decide } = await setup();
  await expect(call({ state: "hi", questions: [] })).rejects.toThrow(
    "questions must map",
  );
  expect(decide).not.toHaveBeenCalled();
});

it.each([
  ["no criteria", { instructions: "Spam?" }, "Spam?"],
  ["empty criteria", { instructions: "Spam?", criteria: {} }, "Spam?"],
  [
    "criteria with neither side set",
    { instructions: "Spam?", criteria: { true: null, false: null } },
    "Spam?",
  ],
  [
    "one side",
    { instructions: "Spam?", criteria: { true: "Ads" } },
    "Spam?\nYes means: Ads",
  ],
  [
    "criteria and no instructions",
    { criteria: { false: "A real message" } },
    "No means: A real message",
  ],
])(
  "writes a noul with %s as the lines Attention uses",
  async (_, given, instructions) => {
    const { call, asked } = await setup();
    await call({ state: "hi", questions: { q: { type: "noul", ...given } } });
    expect(asked()?.questions).toEqual({ q: { type: "yes_no", instructions } });
  },
);

it("repeats a score's levels in its legend as the agent sent them", async () => {
  const { call } = await setup();
  const levels = [{ label: "small" }, { label: "large" }];
  const reply = await call({
    state: "hi",
    questions: {
      size: { type: "score", instructions: "Size?", criteria: levels },
    },
  });
  expect(reply.answers.size.legend).toEqual({ "0": levels[0], "1": levels[1] });
});

it("gives every array in its input schema items", async () => {
  const { tool } = await setup();
  // Some model APIs refuse an array schema without `items`.
  const arrays: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ((node as { type?: unknown }).type === "array") arrays.push(node);
    for (const child of Object.values(node)) walk(child);
  };
  walk(tool.inputSchema);
  expect(arrays.length).toBeGreaterThan(0);
  for (const array of arrays) expect(array).toHaveProperty("items");
});
