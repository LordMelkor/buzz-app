// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { useIdentityNames } from "./react";
import { bindNames, type NameSource } from "./service";
import { createAgentDirectory } from "./testing";

afterEach(cleanup);

const [a, b, c] = ["a", "b", "c"].map((key) => key.repeat(64)) as [
  string,
  string,
  string,
];
const suffix = (key: string) => npubEncode(key).slice(-4);

function fixture() {
  let profiles = new Map([[a, { name: "Alex" }]]);
  const library = {
    status: "ready",
    definitions: [],
    identities: [],
  } as const;
  const listeners = new Set<() => void>();
  const source: NameSource = {
    profiles: {
      snapshot: () => profiles,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const names = bindNames(source, {
    snapshot: () => [createAgentDirectory()],
    subscribe: () => () => {},
  });
  const set = (pubkey: string, name: string) => {
    profiles = new Map([...profiles, [pubkey, { name }]]);
    for (const listener of listeners) listener();
  };
  return {
    names,
    set,
    publish: (pubkey: string, name: string) => act(() => set(pubkey, name)),
  };
}

it("re-renders a names consumer only when a label it resolved changes", () => {
  const { names, publish } = fixture();
  let renders = 0;
  function Author() {
    renders++;
    const resolve = useIdentityNames(names);
    return <span>{resolve(a, "Member")}</span>;
  }
  render(<Author />);
  expect(screen.getByText("Alex")).toBeInTheDocument();
  const settled = renders;
  // Another identity's profile leaves this author's label alone.
  publish(c, "Casey");
  expect(renders).toBe(settled);
  // A namesake changes it.
  publish(b, "Alex");
  expect(screen.getByText(`Alex · ${suffix(a)}`)).toBeInTheDocument();
  publish(a, "Ana");
  expect(screen.getByText("Ana")).toBeInTheDocument();
  expect(renders).toBe(settled + 2);
  names.dispose();
});

it("watches each candidate scope a key was resolved in", () => {
  const { names, publish } = fixture();
  const wide = [a, c];
  const narrow = [a];
  function Author() {
    const resolve = useIdentityNames(names);
    return (
      <>
        <span>wide {resolve(a, "Member", wide)}</span>
        <span>narrow {resolve(a, "Member", narrow)}</span>
      </>
    );
  }
  render(<Author />);
  publish(c, "Alex");
  expect(screen.getByText(`wide Alex · ${suffix(a)}`)).toBeInTheDocument();
  expect(screen.getByText("narrow Alex")).toBeInTheDocument();
  names.dispose();
});

it("shows a name change made between render and subscribe", () => {
  const { names, set } = fixture();
  function Author() {
    const resolve = useIdentityNames(names);
    return <span>{resolve(a, "Member")}</span>;
  }
  function Renamer() {
    set(a, "Ana");
    return null;
  }
  render(
    <>
      <Author />
      <Renamer />
    </>,
  );
  expect(screen.getByText("Ana")).toBeInTheDocument();
  names.dispose();
});

it("shows a name change made between two of its own labels", () => {
  const { names, set } = fixture();
  let renamed = false;
  function Author() {
    const resolve = useIdentityNames(names);
    const first = resolve(a, "Member");
    if (!renamed) {
      renamed = true;
      set(a, "Ana");
    }
    return (
      <span>
        {first} {resolve(c, "Member")}
      </span>
    );
  }
  render(<Author />);
  expect(screen.getByText("Ana Member")).toBeInTheDocument();
  names.dispose();
});

it("follows label changes under StrictMode double rendering", () => {
  const { names, publish } = fixture();
  function Author() {
    const resolve = useIdentityNames(names);
    return <span>{resolve(a, "Member")}</span>;
  }
  render(
    <StrictMode>
      <Author />
    </StrictMode>,
  );
  publish(b, "Alex");
  expect(screen.getByText(`Alex · ${suffix(a)}`)).toBeInTheDocument();
  publish(a, "Ana");
  expect(screen.getByText("Ana")).toBeInTheDocument();
  names.dispose();
});

it("keeps watching after an older resolve callback runs", () => {
  const { names, publish } = fixture();
  const callbacks: ((pubkey: string, fallback: string) => string)[] = [];
  function Author() {
    const resolve = useIdentityNames(names);
    callbacks.push(resolve);
    return <span>{resolve(a, "Member")}</span>;
  }
  render(<Author />);
  publish(b, "Alex");
  expect(screen.getByText(`Alex · ${suffix(a)}`)).toBeInTheDocument();
  callbacks[0]?.(c, "Member");
  publish(a, "Ana");
  expect(screen.getByText("Ana")).toBeInTheDocument();
  names.dispose();
});

it("re-renders on every name change once it resolves too many labels to watch", () => {
  const { names, publish } = fixture();
  const fallbacks = Array.from({ length: 501 }, (_, i) => `Member ${i}`);
  let renders = 0;
  function Author() {
    renders++;
    const resolve = useIdentityNames(names);
    return (
      <span>{fallbacks.map((fallback) => resolve(a, fallback)).at(-1)}</span>
    );
  }
  render(<Author />);
  const settled = renders;
  publish(c, "Casey");
  expect(renders).toBe(settled + 1);
  names.dispose();
});

it("re-renders once and starts over when a label's candidate list changes", () => {
  const { names, publish } = fixture();
  let renders = 0;
  function Author({ members }: { members: readonly string[] }) {
    renders++;
    const resolve = useIdentityNames(names);
    return <span>{resolve(a, "Member", members)}</span>;
  }
  const view = render(<Author members={[a]} />);
  view.rerender(<Author members={[a, c]} />);
  const settled = renders;
  publish(c, "Casey");
  expect(renders).toBe(settled + 1);
  publish(b, "Blair");
  expect(renders).toBe(settled + 1);
  publish(c, "Alex");
  expect(screen.getByText(`Alex · ${suffix(a)}`)).toBeInTheDocument();
  names.dispose();
});
