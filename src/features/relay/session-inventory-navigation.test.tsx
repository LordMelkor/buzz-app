// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentChoices } from "../agents/use-choices";
import { createRelaySession, type RelaySession } from "./session";
import { connectBrokerTransport } from "./transport";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Choices({ session }: { session: RelaySession }) {
  const choices = useAgentChoices(session);
  return <output>{choices.templates.status}</output>;
}
async function setup() {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      stream = value;
    },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const localReads = vi.fn(async (_signal?: AbortSignal) => {
    if (++reads > 1) await held;
    return Response.json({ definitions: [], identities: [] });
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session"))
        return Response.json({
          viewer: "a".repeat(64),
          relayAuthor: "b".repeat(64),
          live: true,
          agentLibrary: true,
        });
      if (url.endsWith("/agent-library"))
        return localReads(init?.signal ?? undefined);
      if (url.endsWith("/stream"))
        return new Response(body, {
          headers: {
            "Content-Type": "text/event-stream",
            "X-Buzz-Live-ID": "1".repeat(32),
          },
        });
      if (url.endsWith("/query")) return Response.json([]);
      if (/\/stream-/.test(url)) return Response.json({});
      throw Error(`Unexpected fixture fetch ${url}`);
    }),
  );
  const transport = await connectBrokerTransport();
  const owner = createRelaySession(transport);
  owners.push(owner);
  const emit = (name: string) => window.dispatchEvent(new Event(name));
  const connected = () =>
    stream.enqueue(
      new TextEncoder().encode(
        'event: state\ndata: {"status":"connected","routes":[]}\n\n',
      ),
    );
  render(<Choices session={owner.session} />);
  connected();
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("ready"),
  );
  await waitFor(() =>
    expect(owner.session.live.snapshot().status).toBe("connected"),
  );
  expect(localReads).toHaveBeenCalledOnce();
  return {
    owner,
    localReads,
    emit,
    release,
    disconnect: () => stream.error(new TypeError("Load failed")),
    renderFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
}

it.each(["cancelled-navigation", "pageshow"] as const)(
  "defers stream-clear/choice refresh until %s resumes the existing document",
  async (resume) => {
    const h = await setup();
    try {
      await act(async () => {
        h.emit("beforeunload");
        h.disconnect();
      });
      // The real broker catch cleared inventory and the mounted choice effect requested it again.
      await waitFor(() =>
        expect(h.owner.session.agentLibrary.snapshot().status).toBe("loading"),
      );
      expect(h.localReads).toHaveBeenCalledOnce();
      if (resume === "pageshow") {
        act(() => {
          h.emit("pagehide");
          h.renderFrame();
        });
        expect(h.localReads).toHaveBeenCalledOnce();
        act(() => {
          h.emit("pageshow");
        });
      } else
        act(() => {
          h.renderFrame();
        });
      await waitFor(() => expect(h.localReads).toHaveBeenCalledTimes(2));
      await act(async () => {
        h.release();
      });
      await waitFor(() =>
        expect(h.owner.session.agentLibrary.snapshot().status).toBe("ready"),
      );
    } finally {
      h.release();
    }
  },
);

it("still clears and refreshes inventory on an ordinary stream disconnect", async () => {
  const h = await setup();
  try {
    await act(async () => {
      h.disconnect();
    });
    await waitFor(() => expect(h.localReads).toHaveBeenCalledTimes(2));
    expect(h.owner.session.agentLibrary.snapshot().status).toBe("loading");
    await act(async () => {
      h.release();
    });
    await waitFor(() =>
      expect(h.owner.session.agentLibrary.snapshot().status).toBe("ready"),
    );
  } finally {
    h.release();
  }
});
