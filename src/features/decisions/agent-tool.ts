// The `decisions_ask` agent tool: an agent asks typed questions about some
// content, and the provider its owner chose in Settings answers. It takes and
// returns TypeSafe's System One format, which agents may already know from its
// docs (https://docs.typesafe.ai/api/system-one.md), and maps it onto
// `Decisions`.
// Jev's `model`, images, box questions and `usage` are left out: the owner's
// provider answers, and it takes text.
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type {
  DecisionAnswer,
  DecisionFailure,
  DecisionQuestion,
  Decisions,
} from "./service";

/** Agent calls in flight at once, across every agent on the device. The
 * native client has 16 slots, which Attention's classifier also uses; it lets
 * an event through when it cannot decide in time, so agents keep to a few. */
export const AGENT_CALL_LIMIT = 4;

const json = {
  anyOf: [{ type: "string" }, { type: "object" }, { type: "array", items: {} }],
};

const FAILURES: Record<DecisionFailure, string> = {
  unavailable:
    "No decisions provider is set up on this device. Your owner can choose one in Settings > Decisions API.",
  missing_credentials:
    "The decisions provider has no key or sign-in. Your owner can set it up in Settings > Decisions API.",
  unauthorized:
    "The decisions provider refused your owner's key or sign-in. Your owner can fix it in Settings > Decisions API.",
  invalid_request:
    "The provider refused the request. state must not be empty; a choice takes 2 to 255 criteria and a score 2 to 10. Ask 1 to 32 questions, each named in at most 64 characters.",
  input_limit: "The request is over 128 KiB. Send less state.",
  timeout: "The provider did not answer within 30 seconds. Try again.",
  service_error: "The provider failed. Try again later.",
  invalid_response:
    "The provider's answer did not fit the questions. Try again later.",
};

/** Text as is; any other JSON as its text. */
const asText = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** One System One question as `Decisions` asks it. */
function question(name: string, raw: unknown): DecisionQuestion {
  if (!record(raw)) throw new Error(`Question ${name} must be an object.`);
  const instructions = asText(raw.instructions);
  const { criteria } = raw;
  switch (raw.type) {
    case "noul": {
      const given = criteria ?? {};
      if (
        !record(given) ||
        !Object.keys(given).every((key) => key === "true" || key === "false")
      )
        throw new Error(
          `Question ${name}: a noul's criteria is {"true": …, "false": …}.`,
        );
      const means = (key: "true" | "false", label: string) =>
        given[key] === undefined || given[key] === null
          ? []
          : [`${label} means: ${asText(given[key])}`];
      const lines = [
        instructions,
        ...means("true", "Yes"),
        ...means("false", "No"),
      ];
      return { type: "yes_no", instructions: lines.filter(Boolean).join("\n") };
    }
    case "choice":
      if (!record(criteria))
        throw new Error(
          `Question ${name}: a choice's criteria maps each choice to when it applies.`,
        );
      return {
        type: "choice",
        instructions,
        options: Object.fromEntries(
          Object.entries(criteria).map(([choice, when]) => [
            choice,
            when === null || when === undefined ? "" : asText(when),
          ]),
        ),
      };
    case "score":
      if (!Array.isArray(criteria))
        throw new Error(
          `Question ${name}: a score's criteria lists its levels, lowest first.`,
        );
      return { type: "score", instructions, levels: criteria.map(asText) };
    default:
      throw new Error(`Question ${name}: type must be noul, choice or score.`);
  }
}

/** One answer in System One's format. `criteria` is the question's, as the
 * agent sent it, so a score's legend repeats its levels unchanged. */
function answer(given: DecisionAnswer, criteria: unknown) {
  switch (given.type) {
    case "yes_no":
      return { type: "noul", noul: given.probability };
    case "choice":
      return given;
    case "score":
      return {
        ...given,
        legend: Object.fromEntries(
          (Array.isArray(criteria) ? criteria : []).map((level, i) => [
            String(i),
            level,
          ]),
        ),
      };
  }
}

export function registerDecideTool(
  agents: Readonly<{
    addTool(tool: AddedTool): void;
    snapshot(): Readonly<{
      running: readonly Readonly<{ key: string; relay: string }>[];
    }>;
  }>,
  decisions: Decisions,
) {
  let running = 0;
  agents.addTool({
    name: "decisions_ask",
    description:
      "Ask fast yes/no (noul), choice or score questions about some content, in TypeSafe's System One format (https://docs.typesafe.ai/api/system-one.md). The decisions provider your owner chose in Settings answers, so it sees state and questions: send only what it needs. Differences: each question needs instructions (a noul may give criteria instead), a choice needs 2 to 255 criteria and a score 2 to 10, there is no model, images or box, and the reply has no usage. Answers come back under each question's name: a noul is the probability of yes; a choice or score has its confidence and, where the provider reports them, a probability for each option or level.",
    inputSchema: {
      type: "object",
      properties: {
        state: { ...json, description: "The content every question is about." },
        questions: {
          type: "object",
          description:
            "1 to 32 questions, each under a name of at most 64 characters.",
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["noul", "choice", "score"] },
              instructions: json,
              criteria: {
                anyOf: [{ type: "object" }, { type: "array", items: {} }],
                description:
                  'noul (optional): {"true": …, "false": …}, what each answer means. choice: 2 to 255 choices, each mapped to when it applies. score: 2 to 10 levels, lowest first.',
              },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
    async call(client, _context, args) {
      if (!record(args.questions))
        throw new Error("questions must map each name to a question.");
      const questions = Object.fromEntries(
        Object.entries(args.questions).map(([name, raw]) => {
          const asked = question(name, raw);
          if (!asked.instructions.trim())
            throw new Error(
              `Question ${name} needs instructions, or for a noul, criteria.`,
            );
          return [name, asked];
        }),
      );
      if (running >= AGENT_CALL_LIMIT)
        throw new Error(
          `${AGENT_CALL_LIMIT} decisions from agents on this device are already waiting for answers. Try again shortly. (busy)`,
        );
      // The agent's community, which a provider such as Builderlab bills.
      const community = agents
        .snapshot()
        .running.find((agent) => agent.key === client.key)?.relay;
      running++;
      const result = await decisions
        .decide({
          state: asText(args.state),
          questions,
          ...(community ? { community } : {}),
        })
        .finally(() => running--);
      if (result.outcome === "failed")
        throw new Error(`${FAILURES[result.reason]} (${result.reason})`);
      return JSON.stringify({
        model: result.model,
        provider: result.backend,
        answers: Object.fromEntries(
          Object.entries(result.answers).map(([name, given]) => [
            name,
            answer(
              given,
              (args.questions as Record<string, { criteria?: unknown }>)[name]
                ?.criteria,
            ),
          ]),
        ),
      });
    },
  });
}
