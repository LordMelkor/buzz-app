import type { BuzzClient } from "./client";
import { respond } from "./rpc";
import { TOOLS } from "./tools";
import type { ExternalScope } from "../features/agents/external-connection";

type Policy = Readonly<{
  scope: ExternalScope;
  fields: readonly string[];
  required?: readonly string[];
}>;
const supportedScopes: readonly ExternalScope[] = ["read", "post"];
const policies: Readonly<Record<string, Policy>> = {
  channel_list: { scope: "read", fields: ["q", "all", "types"] },
  channel_get: { scope: "read", fields: ["channel"], required: ["channel"] },
  read: {
    scope: "read",
    fields: [
      "channel",
      "thread",
      "message_url",
      "q",
      "author",
      "since",
      "before",
      "before_id",
      "limit",
    ],
  },
  send: {
    scope: "post",
    fields: ["channel", "text", "reply", "mentions", "audience"],
    required: ["channel", "text", "audience"],
  },
  reply_in_subthread: {
    scope: "post",
    fields: ["parent", "text", "mentions", "audience"],
    required: ["parent", "text", "audience"],
  },
};
const tools = TOOLS.filter((tool) => Object.hasOwn(policies, tool.name)).map(
  (tool) => {
    const policy = policies[tool.name] as Policy;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: Object.fromEntries(
          Object.entries(tool.inputSchema.properties).filter(([name]) =>
            policy.fields.includes(name),
          ),
        ),
        ...(policy.required ? { required: policy.required } : {}),
        ...(tool.name === "read"
          ? {
              anyOf: [
                { required: ["channel"] },
                { required: ["thread"] },
                { required: ["message_url"] },
              ],
            }
          : {}),
      },
      annotations: { readOnlyHint: policy.scope === "read" },
      _meta: { "buzz/requiredScopes": [policy.scope] },
    };
  },
);

function validate(
  value: unknown,
  schema: {
    type?: string;
    enum?: readonly unknown[];
    items?: object;
    minItems?: number;
    uniqueItems?: boolean;
  },
  name: string,
) {
  const valid =
    schema.type === "array"
      ? Array.isArray(value)
      : schema.type === "integer"
        ? Number.isSafeInteger(value)
        : typeof value === schema.type;
  if (!valid || (schema.enum && !schema.enum.includes(value)))
    throw new Error(`Invalid ${name}.`);
  if (
    Array.isArray(value) &&
    ((schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.uniqueItems && new Set(value).size !== value.length))
  )
    throw new Error(`Invalid ${name}.`);
  if (Array.isArray(value) && schema.items)
    for (const item of value) validate(item, schema.items, name);
}

/** The external grant has no implicit conversation and cannot call plugin tools. */
export async function respondExternal(
  client: BuzzClient,
  input: unknown,
  connected: () => void,
  scopes: readonly ExternalScope[] = ["read", "post"],
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected one JSON-RPC message.");
  const message = input as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return undefined;
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error("params must be an object.");
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  if (method === "initialize") {
    if (params.protocolVersion !== "2025-06-18")
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Use MCP 2025-06-18." },
      };
    connected();
  }
  if (method === "tools/list") {
    if (params.cursor !== undefined)
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Tool cursors are not supported." },
      };
    return result({
      tools,
      _meta: {
        "buzz/grantedScopes": supportedScopes.filter((scope) =>
          scopes.includes(scope),
        ),
        "buzz/supportedScopes": supportedScopes,
      },
    });
  }
  if (method === "tools/call") {
    try {
      const tool = tools.find((tool) => tool.name === params.name);
      if (!tool)
        throw new Error(
          "This tool is not available through the external connection.",
        );
      const policy = policies[tool.name] as Policy;
      if (!scopes.includes(policy.scope))
        return result({
          isError: true,
          content: [
            {
              type: "text",
              text: "Additional Buzz access is required. Request authorization, then call this tool again.",
            },
          ],
          _meta: {
            "buzz/error": {
              code: "authorization_required",
              required_scopes: [policy.scope],
            },
          },
        });
      const args = params.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("arguments must be an object.");
      const values = args as Record<string, unknown>;
      for (const [name, value] of Object.entries(values)) {
        const schema = tool.inputSchema.properties[name];
        if (!schema)
          throw new Error(`${name} cannot be used with ${tool.name}.`);
        validate(value, schema, name);
      }
      for (const name of policy.required ?? [])
        if (typeof values[name] !== "string" || !values[name].trim())
          throw new Error(`${name} is required.`);
      if (tool.name === "read")
        for (const name of ["channel", "thread", "message_url"])
          if (values[name] !== undefined && !(values[name] as string).trim())
            throw new Error(`${name} must not be blank.`);
      if (
        tool.name === "read" &&
        !values.channel &&
        !values.thread &&
        !values.message_url
      )
        throw new Error("channel, thread, or message_url is required.");
      if (
        tool.name === "read" &&
        values.q &&
        !values.channel &&
        !values.message_url
      )
        throw new Error("channel is required with q.");
    } catch (error) {
      return result({
        isError: true,
        content: [{ type: "text", text: (error as Error).message }],
      });
    }
  }
  return respond(client, {}, input, [], {
    instructions:
      "Act as the agent selected by the owner in Buzz. Supply explicit channel or message IDs. Keys stay in Buzz. If this connection ends, start setup again in the external app and authorize it in Buzz.",
  });
}
