// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import {
  ARTIFACT_KIND,
  type Delivery,
  type SnapshotRead,
} from "./agent-config-artifacts";
import { AgentConfigHistory } from "./AgentConfigHistory";
import { HISTORY_PAGE } from "./agent-config-history";

afterEach(cleanup);
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const d = "5b1d3b52-6c4e-5a0b-8e3c-1f2a3b4c5d6e";
const expected = { channel, d, type: "buzz.agent.instructions" as const };
const rev = (
  id: string,
  prev: string | undefined,
  text: string,
  content = JSON.stringify({ version: 1, text }),
): RelayEvent =>
  ({
    id,
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    kind: ARTIFACT_KIND,
    created_at: 1_700_000_000,
    content,
    tags: [
      ["ar", "1"],
      ["d", d],
      ["h", channel],
      ["type", "buzz.agent.instructions"],
      ["title", "Agent instructions"],
      ["op", prev ? "update" : "create"],
      ...(prev ? [["prev", prev]] : []),
    ],
  }) as RelayEvent;

it("pages older history, labels the gap, shows a diff and reverts on the head", async () => {
  // Newest first: r(n-1) … r0; one revision beyond the first page.
  const revisions = Array.from({ length: HISTORY_PAGE + 1 }, (_, i) =>
    rev(`r${i}`, i ? `r${i - 1}` : undefined, `line ${i}`),
  ).reverse();
  let fail = false;
  const read: SnapshotRead = async ([filter]) => {
    if (fail) throw new Error("offline");
    if (!filter?.["#h"]?.includes(channel)) return [];
    const offset = filter?.offset ?? 0;
    return revisions.slice(offset, offset + (filter?.limit ?? 0));
  };
  const head = revisions[0] as RelayEvent;
  const onRevert = vi.fn(
    async (): Promise<Delivery> => ({ status: "accepted", event: head }),
  );
  render(
    <AgentConfigHistory
      expected={expected}
      head={head}
      read={read}
      onRevert={onRevert}
    />,
  );

  expect(
    await screen.findByText("Older revisions aren't loaded yet."),
  ).toBeInTheDocument();
  fail = true;
  fireEvent.click(screen.getByText("Load older"));
  expect(
    await screen.findByText("Couldn't load older revisions."),
  ).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByText("Retry"));
  expect(await screen.findAllByText(/^create/)).toHaveLength(1);
  expect(screen.queryByText(/aren't loaded|Couldn't load/)).toBeNull();

  const [first] = screen.getAllByText("Show changes");
  fireEvent.click(first as HTMLElement);
  const diff = screen.getByRole("region", { name: "Changes" });
  expect(diff).toHaveTextContent(`− line ${HISTORY_PAGE - 1}`);
  expect(diff).toHaveTextContent(`+ line ${HISTORY_PAGE}`);

  const reverts = screen.getAllByText("Revert to this");
  expect(reverts).toHaveLength(HISTORY_PAGE);
  fireEvent.click(reverts[0] as HTMLElement);
  expect(onRevert).toHaveBeenCalledOnce();
  const [template] = onRevert.mock.calls[0] as unknown as [
    { content: string; tags: string[][] },
  ];
  expect(template.content).toBe(revisions[1]?.content);
  expect(template.tags).toContainEqual(["op", "update"]);
  expect(template.tags).toContainEqual(["prev", head.id]);
});

it("labels a predecessor missing from complete history unavailable", async () => {
  const read: SnapshotRead = async () => [
    rev("r2", "r1", "b"),
    rev("r0", undefined, "a"),
  ];
  render(
    <AgentConfigHistory
      expected={expected}
      head={undefined}
      read={read}
      onRevert={async () => ({ status: "accepted", event: rev("x", "y", "") })}
    />,
  );
  expect(
    await screen.findByText(
      "A revision here isn't available (removed or expired).",
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("list")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Revert to this" })).toBeNull();
});

it("shows an invalid revision honestly and never offers to revert to it", async () => {
  const head = rev("r2", "r1", "fixed");
  const read: SnapshotRead = async () => [
    head,
    rev("r1", "r0", "", "not-json"),
    rev("r0", undefined, "first"),
  ];
  render(
    <AgentConfigHistory
      expected={expected}
      head={head}
      read={read}
      onRevert={vi.fn()}
    />,
  );
  expect(await screen.findByText(/^update · Not valid/)).toBeInTheDocument();
  // Only r0 can be reverted to: r2 is current, r1 is malformed.
  expect(screen.getAllByText("Revert to this")).toHaveLength(1);
  const [, invalid] = screen.getAllByText("Show changes");
  fireEvent.click(invalid as HTMLElement);
  expect(
    screen.getByText(
      /This revision isn't valid config \(Artifact content is not JSON\)/,
    ),
  ).toBeInTheDocument();
});

it("shows a failed revert beside the revision, keeps history and allows retry", async () => {
  const head = rev("r1", "r0", "new");
  const read: SnapshotRead = async () => [head, rev("r0", undefined, "old")];
  let settle: (delivery: Delivery) => void = () => {};
  const onRevert = vi.fn(
    () =>
      new Promise<Delivery>((resolve) => {
        settle = resolve;
      }),
  );
  render(
    <AgentConfigHistory
      expected={expected}
      head={head}
      read={read}
      onRevert={onRevert}
    />,
  );
  const button = () => screen.getByRole("button", { name: "Revert to this" });
  fireEvent.click(await screen.findByText("Revert to this"));
  await waitFor(() => expect(button()).toHaveAttribute("aria-busy", "true"));
  settle({
    status: "refused",
    event: head,
    refusal: "permission",
    message: "restricted: no longer allowed",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Not reverted: restricted: no longer allowed",
  );
  expect(button()).not.toHaveAttribute("aria-busy", "true");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);

  fireEvent.click(button());
  settle({ status: "uncertain", event: head, message: "connection lost" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't confirm the revert was saved (connection lost)",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("Not reverted");

  onRevert.mockRejectedValueOnce(new Error("signer unavailable"));
  fireEvent.click(button());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't confirm the revert was saved (signer unavailable)",
  );

  fireEvent.click(button());
  settle({ status: "accepted", event: head });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(onRevert).toHaveBeenCalledTimes(4);
});
