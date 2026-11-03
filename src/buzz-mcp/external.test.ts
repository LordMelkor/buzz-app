import { expect, it, vi } from "vitest";
import type { BuzzClient, BuzzEvent } from "./client";
import { respondExternal } from "./external";

function fixture(events: BuzzEvent[] = []) {
  const query = vi.fn(async () => events);
  const publish = vi.fn(async (event) => ({ ...event, id: "d".repeat(64) }));
  const read = vi.fn(async () => {
    throw new Error("file access");
  });
  const client = {
    pubkey: "a".repeat(64),
    key: "a".repeat(64),
    query,
    publish,
    read,
  } as unknown as BuzzClient;
  const call = (name: string, args: unknown) =>
    respondExternal(
      client,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      () => {},
    );
  return { client, query, publish, read, call };
}

it("lists the restricted schemas and negotiates only the external protocol", async () => {
  const { client } = fixture();
  const connected = vi.fn();
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  };
  expect(await respondExternal(client, request, connected)).toHaveProperty(
    "error.code",
    -32602,
  );
  expect(connected).not.toHaveBeenCalled();
  request.params.protocolVersion = "2025-06-18";
  expect(await respondExternal(client, request, connected)).toHaveProperty(
    "result.protocolVersion",
    "2025-06-18",
  );
  expect(connected).toHaveBeenCalledOnce();
  const list = await respondExternal(
    client,
    { id: 2, method: "tools/list" },
    connected,
  );
  const tools = (
    list as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties: object; required?: string[] };
        }[];
      };
    }
  ).result.tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "channel_get",
    "channel_list",
    "read",
    "reply_in_subthread",
    "send",
  ]);
  const send = tools.find((tool) => tool.name === "send");
  expect(send?.inputSchema.properties).not.toHaveProperty("files");
  expect(send?.inputSchema.properties).not.toHaveProperty("path");
  expect(send?.inputSchema.required).toEqual(["channel", "text", "audience"]);
  expect(
    await respondExternal(
      client,
      { id: 3, method: "tools/list", params: { cursor: "next" } },
      connected,
    ),
  ).toHaveProperty("error.code", -32602);
  expect(
    await respondExternal(
      client,
      { method: "notifications/initialized" },
      connected,
    ),
  ).toBeUndefined();
});

it.each([
  ["run", { command: "pwd" }],
  ["media_get", { url: "https://example.test/image" }],
  ["git_auth", {}],
  ["mem_list", {}],
  ["agent_create", {}],
  [
    "send",
    {
      channel: "chan",
      text: "text",
      audience: "everyone",
      path: "/tmp/private",
    },
  ],
  [
    "send",
    {
      channel: "chan",
      text: "text",
      audience: "everyone",
      files: ["/tmp/private"],
    },
  ],
  ["send", { text: "text", audience: "everyone" }],
  ["send", { channel: "chan", text: "text", audience: "user" }],
  [
    "send",
    { channel: "chan", text: "text", audience: "everyone", mentions: [false] },
  ],
  ["read", { q: "text" }],
  ["read", { channel: " ", q: "needle" }],
  ["read", { channel: " " }],
  ["read", { thread: " " }],
  ["read", { message_url: " " }],
  ["read", { message_url: "https://example.test/message" }],
  ["read", { message_url: `buzz://channel/chan` }],
  [
    "read",
    {
      message_url: `buzz://message?channel=chan&id=${"a".repeat(64)}`,
      channel: "other",
    },
  ],
  ["read", { channel: "chan", limit: 1.5 }],
  ["channel_get", {}],
  ["channel_list", { all: "true" }],
  ["channel_list", { types: ["unknown"] }],
  ["channel_list", { types: [] }],
  ["reply_in_subthread", { text: "text", audience: "everyone" }],
])(
  "rejects unsafe or invalid %s arguments before accessing the client",
  async (name, args) => {
    const { call, query, publish, read } = fixture();
    expect(await call(name as string, args)).toHaveProperty(
      "result.isError",
      true,
    );
    expect(query).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  },
);

it("posts text through the shared handler with the selected identity", async () => {
  const { call, publish, read } = fixture();
  expect(
    await call("send", {
      channel: "chan",
      text: "Test message",
      audience: "agents",
    }),
  ).toHaveProperty("result.content.0.text", `sent ${"d".repeat(64)}`);
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 9,
      content: "Test message",
      tags: expect.arrayContaining([
        ["h", "chan"],
        ["audience", "agents"],
      ]),
    }),
  );
  expect(read).not.toHaveBeenCalled();
});

it("reads a message link through the shared handler without an implicit target", async () => {
  const id = "a".repeat(64);
  const { call } = fixture([
    {
      id,
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 9,
      content: "Linked message",
      tags: [["h", "chan"]],
      sig: "",
    },
  ]);
  const reply = await call("read", {
    message_url: `buzz://message?channel=chan&id=${id}`,
  });
  expect(reply).toHaveProperty(
    "result.content.0.text",
    expect.stringContaining(`thread ${id} in chan`),
  );
  expect(reply).toHaveProperty(
    "result.content.0.text",
    expect.stringContaining("Linked message"),
  );
});

it("enforces read-only scope even when a caller asks for a post tool", async () => {
  const { client, publish } = fixture();
  const call = await respondExternal(
    client,
    {
      id: 1,
      method: "tools/call",
      params: {
        name: "send",
        arguments: { channel: "chan", text: "blocked", audience: "everyone" },
      },
    },
    () => {},
    ["read"],
  );
  expect(call).toHaveProperty("result.isError", true);
  expect(publish).not.toHaveBeenCalled();
  const list = await respondExternal(
    client,
    { id: 2, method: "tools/list" },
    () => {},
    ["read"],
  );
  expect(list).toHaveProperty(
    "result.tools",
    expect.arrayContaining([expect.objectContaining({ name: "read" })]),
  );
  expect(list).toHaveProperty("result._meta", {
    "buzz/grantedScopes": ["read"],
    "buzz/supportedScopes": ["read", "post"],
  });
  expect(list).toHaveProperty(
    "result.tools",
    expect.arrayContaining([
      expect.objectContaining({
        name: "send",
        _meta: { "buzz/requiredScopes": ["post"] },
      }),
    ]),
  );
  expect(call).toHaveProperty("result._meta.buzz/error", {
    code: "authorization_required",
    required_scopes: ["post"],
  });
  expect(publish).not.toHaveBeenCalled();
  const granted = ["read", "post"] as const;
  const explicit = await respondExternal(
    client,
    {
      id: 3,
      method: "tools/call",
      params: {
        name: "send",
        arguments: {
          channel: "chan",
          text: "After approval",
          audience: "everyone",
        },
      },
    },
    () => {},
    granted,
  );
  expect(explicit).toHaveProperty(
    "result.content.0.text",
    `sent ${"d".repeat(64)}`,
  );
  expect(publish).toHaveBeenCalledOnce();
});
