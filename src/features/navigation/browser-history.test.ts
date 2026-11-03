import { expect, it } from "vitest";
import { createBrowserHistory } from "./browser-history";
import { createNavigationController } from "./controller";
import { createMemoryHistory, homeTarget } from "./history";

const settings = {
  version: 1,
  kind: "settings",
  section: "appearance",
} as const;
const hash = (target: unknown) =>
  `#buzz=${encodeURIComponent(JSON.stringify(target))}`;
function browser(initialHash = "", deferredTraversal = false) {
  const events = new EventTarget();
  const pending: number[] = [];
  let entries = [{ state: null as unknown, hash: initialHash }],
    index = 0;
  const location = { pathname: "/", search: "", hash: initialHash };
  const storage = new Map<string, string>();
  const history = {
    get state() {
      return entries[index]?.state;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      if (url) location.hash = new URL(url, "https://app.example").hash;
      entries[index] = { state, hash: location.hash };
    },
    pushState(state: unknown, _title: string, url: string) {
      entries = entries.slice(0, index + 1);
      location.hash = new URL(url, "https://app.example").hash;
      entries.push({ state, hash: location.hash });
      index++;
    },
    back() {
      traverse(-1);
    },
    forward() {
      traverse(1);
    },
    go(delta: number) {
      if (deferredTraversal) pending.push(delta);
      else traverse(delta);
    },
  };
  function notify() {
    events.dispatchEvent(new Event("popstate"));
    events.dispatchEvent(new Event("hashchange"));
  }
  function traverse(delta: number) {
    if (!entries[index + delta]) return;
    index += delta;
    location.hash = entries[index]?.hash ?? "";
    notify();
  }
  const host = {
    history,
    location,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window;
  return {
    host,
    edit(value: string) {
      history.pushState(null, "", `/${value}`);
      notify();
    },
    flush() {
      for (const delta of pending.splice(0)) traverse(delta);
    },
    pending: () => pending.length,
    length: () => entries.length,
  };
}
for (const kind of ["memory", "browser"] as const) {
  const page = {
    version: 1,
    kind: "page",
    pluginId: "test",
    pageId: "page",
  } as const;
  const thread = { ...page, route: { version: 1, params: "thread" } } as const;
  const other = { ...page, route: { version: 1, params: "other" } } as const;
  const setup = () =>
    kind === "memory"
      ? createMemoryHistory()
      : createBrowserHistory(browser().host);

  it(`${kind}: closing a dialog retires its sections in both directions and preserves other destinations`, () => {
    const driver = setup();
    driver.push(page);
    const opener = driver.snapshot().current;
    driver.push(settings);
    driver.push({ ...settings, section: "notifications" });
    driver.back();
    expect(driver.snapshot().current.target).toEqual(settings);
    driver.dismiss((target) => target.kind === "settings", page);
    expect(driver.snapshot().current).toEqual(opener);
    expect(driver.snapshot().canGoForward).toBe(false);
    driver.back();
    expect(driver.snapshot().current.target).toEqual(homeTarget);
    driver.forward();
    expect(driver.snapshot().current).toEqual(opener);
    driver.push(settings);
    expect(driver.snapshot().current.target).toEqual(settings);
    driver.dispose();
  });

  it(`${kind}: dismissal matching cannot partially retire visits when a matcher fails`, () => {
    const driver = setup();
    driver.push(page);
    driver.push(settings);
    driver.push({ ...settings, section: "notifications" });
    expect(() =>
      driver.dismiss((target) => {
        if (target.kind === "settings" && target.section === "notifications")
          throw new Error("invalid match");
        return target.kind === "settings";
      }, page),
    ).toThrow("invalid match");
    driver.back();
    expect(driver.snapshot().current.target).toEqual(settings);
    driver.dispose();
  });

  it(`${kind}: passive traversal retains a visit; explicit dismissal removes it from both directions`, () => {
    const driver = setup();
    driver.push(page);
    const channel = driver.snapshot().current;
    driver.push(thread);
    const opened = driver.snapshot().current;
    driver.back();
    expect(driver.snapshot().current).toEqual(channel);
    driver.forward();
    expect(driver.snapshot().current).toEqual(opened);
    driver.dismiss([opened.id], page);
    expect(driver.snapshot().current).toEqual(channel);
    expect(driver.snapshot().canGoForward).toBe(false);
    driver.back();
    expect(driver.snapshot().current.target).toEqual(homeTarget);
    driver.forward();
    expect(driver.snapshot().current).toEqual(channel);
    driver.push(thread); // Explicitly reopening starts an ordinary new visit.
    expect(driver.snapshot().current.id).not.toBe(opened.id);
    driver.dispose();
  });

  it(`${kind}: closing an inactive tab skips its earlier visits and preserves other content`, () => {
    const driver = setup();
    driver.push(page);
    driver.push(thread);
    const closed = driver.snapshot().current.id;
    driver.push(other);
    const selected = driver.snapshot().current;
    driver.dismiss([closed], page);
    expect(driver.snapshot().current).toEqual(selected);
    driver.back();
    expect(driver.snapshot().current.target).toEqual(page);
    driver.forward();
    expect(driver.snapshot().current).toEqual(selected);
    driver.dispose();
  });

  it(`${kind}: a direct thread entry closes in place instead of returning to an unrelated page`, () => {
    const driver = setup();
    driver.push(thread);
    driver.dismiss([driver.snapshot().current.id], page);
    expect(driver.snapshot().current.target).toEqual(page);
    driver.back();
    expect(driver.snapshot().current.target).toEqual(homeTarget);
    driver.dispose();
  });
}

it("reload retains the immediate opener so dismissal leaves no duplicate stop", () => {
  const b = browser();
  let driver = createBrowserHistory(b.host);
  driver.push(settings);
  const opener = driver.snapshot().current;
  driver.push({ ...settings, section: "notifications" });
  const dialog = driver.snapshot().current;
  driver.dispose();
  driver = createBrowserHistory(b.host);
  driver.dismiss([dialog.id], opener.target);
  expect(driver.snapshot().current).toEqual(opener);
  expect(driver.snapshot().canGoForward).toBe(false);
  driver.back();
  expect(driver.snapshot().current.target).toEqual(homeTarget);
  driver.dispose();
});

it("native traversal skips dismissed entries, including after reloading the driver", () => {
  const b = browser();
  let driver = createBrowserHistory(b.host);
  driver.push(settings);
  const dismissed = driver.snapshot().current.id;
  driver.push({ ...settings, section: "notifications" });
  const selected = driver.snapshot().current;
  driver.dismiss([dismissed], homeTarget);
  b.host.history.back();
  expect(driver.snapshot().current.target).toEqual(homeTarget);
  driver.dispose();
  driver = createBrowserHistory(b.host);
  b.host.history.forward();
  expect(driver.snapshot().current).toEqual(selected);
  driver.dispose();
});
it("adopts a hash edit exactly once, preserves visits and restores forward after reload", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  let notifications = 0;
  driver.attach(() => notifications++);
  const home = driver.snapshot().current.id;
  b.edit(hash(settings));
  expect(notifications).toBe(1);
  expect(b.length()).toBe(2);
  const opened = driver.snapshot().current;
  expect(opened.target).toEqual(settings);
  driver.back();
  expect(driver.snapshot().current.id).toBe(home);
  driver.dispose();
  const reloaded = createBrowserHistory(b.host);
  expect(reloaded.snapshot().canGoForward).toBe(true);
  reloaded.forward();
  expect(reloaded.snapshot().current).toEqual(opened);
  reloaded.dispose();
});
it("invalid addresses settle failure, including retry, until explicit navigation leaves them", async () => {
  const b = browser("#buzz=%7B");
  const controller = createNavigationController(createBrowserHistory(b.host));
  expect(controller.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "invalid-target",
  });
  expect(await controller.navigation.retry()).toEqual({
    status: "failed",
    reason: "invalid-target",
  });
  const pending = controller.navigation.open(homeTarget);
  expect(controller.navigation.snapshot().status).toBe("opening");
  controller.complete(controller.navigation.snapshot().attempt, {
    status: "opened",
  });
  expect(await pending).toEqual({ status: "opened" });
  controller.navigation.back();
  expect(controller.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "invalid-target",
  });
  controller.dispose();
});
it("counts Back/Forward as traversal, not an edited address", () => {
  const b = browser();
  const controller = createNavigationController(createBrowserHistory(b.host));
  const nav = controller.navigation;
  b.edit(hash(settings));
  expect(nav.snapshot().entry.target).toEqual(settings);
  expect(nav.snapshot().attempt.traversal).toBeUndefined();
  nav.back();
  expect(nav.snapshot().entry.target).toEqual(homeTarget);
  expect(nav.snapshot().attempt.traversal).toBe(true);
  nav.forward();
  expect(nav.snapshot().entry.target).toEqual(settings);
  expect(nav.snapshot().attempt.traversal).toBe(true);
  controller.dispose();
});
it("the URL overrides a mismatched restored stamp", () => {
  const b = browser();
  createBrowserHistory(b.host).dispose();
  b.host.location.hash = hash(settings);
  const driver = createBrowserHistory(b.host);
  expect(driver.snapshot().current.target).toEqual(settings);
  driver.dispose();
});
it("driver attachment is exclusive even after detachment", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  driver.attach(() => {})();
  expect(() => driver.attach(() => {})).toThrow("already has an owner");
  driver.dispose();
});

it("resolving a visit rewrites its address without losing identity or the forward branch", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  const host = createNavigationController(driver);
  void host.navigation.open(settings);
  const forward = host.navigation.snapshot().entry;
  host.navigation.back();
  const current = host.navigation.snapshot().attempt;
  expect(
    host.resolve(current, { version: 1, kind: "settings", section: "profile" }),
  ).toBe(true);
  expect(host.navigation.snapshot().entry.id).toBe(current.entry.id);
  expect(host.navigation.snapshot().canGoForward).toBe(true);
  expect(b.length()).toBe(2);
  expect(b.host.location.hash).toBe(
    hash({ version: 1, kind: "settings", section: "profile" }),
  );
  host.navigation.forward();
  expect(host.navigation.snapshot().entry).toEqual(forward);
  host.dispose();
});

it("returns from multiple Settings sections to the original workspace visit without pushing", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  const original = driver.snapshot().current;
  driver.push(settings);
  driver.push({ ...settings, section: "profile" });
  expect(driver.returnTo(original.id)).toBe(true);
  expect(driver.snapshot().current).toEqual(original);
  expect(b.length()).toBe(3);
  expect(driver.snapshot().canGoForward).toBe(true);
  expect(driver.returnTo("unknown")).toBe(false);
  driver.dispose();
});

it("retains the immediate opener across reload for explicit dismissal", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  const original = driver.snapshot().current;
  expect(driver.snapshot().previous).toBeUndefined();
  driver.push(settings);
  expect(driver.snapshot().previous).toEqual(original);
  driver.replace({ ...settings, section: "profile" });
  expect(driver.snapshot().previous).toEqual(original);
  driver.dispose();
  const restored = createBrowserHistory(b.host);
  expect(restored.snapshot().canGoBack).toBe(true);
  expect(restored.snapshot().previous).toEqual(original);
  restored.dispose();
});

it("dismisses after a deferred traversal with the requested focus and no new visit", () => {
  const b = browser("", true);
  const host = createNavigationController(createBrowserHistory(b.host));
  const opener = host.navigation.snapshot().entry;
  void host.navigation.open(settings);
  void host.navigation.open(homeTarget, { dismiss: true, focus: "preserve" });
  expect(b.pending()).toBe(1);
  b.flush();
  expect(host.navigation.snapshot().entry).toEqual(opener);
  expect(host.navigation.snapshot().attempt.focus).toBe("preserve");
  expect(host.navigation.snapshot().canGoForward).toBe(true);
  expect(b.length()).toBe(2);
  host.dispose();
});

it("coalesces repeated Close requests before browser traversal commits", () => {
  const b = browser("", true);
  const driver = createBrowserHistory(b.host);
  const original = driver.snapshot().current;
  driver.push(settings);
  driver.push({ ...settings, section: "profile" });
  expect(driver.returnTo(original.id)).toBe(true);
  expect(driver.returnTo(original.id)).toBe(true);
  expect(b.pending()).toBe(1);
  b.flush();
  expect(driver.snapshot().current).toEqual(original);
  driver.dispose();
});

it("coalesces repeated dismissal before traversal commits and permits a later dismissal", () => {
  const b = browser("", true);
  const driver = createBrowserHistory(b.host);
  const channel = {
    version: 1,
    kind: "page",
    pluginId: "test",
    pageId: "channel",
  } as const;
  driver.push(channel);
  const opener = driver.snapshot().current;
  driver.push(settings);
  const dialog = driver.snapshot().current;
  driver.dismiss([dialog.id], channel);
  driver.dismiss((target) => target.kind === "settings", channel);
  expect(b.pending()).toBe(1);
  b.flush();
  expect(driver.snapshot().current).toEqual(opener);
  expect(driver.snapshot().canGoForward).toBe(false);
  driver.push(settings);
  driver.dismiss((target) => target.kind === "settings", channel);
  expect(b.pending()).toBe(1);
  b.flush();
  expect(driver.snapshot().current).toEqual(opener);
  driver.back();
  b.flush();
  expect(driver.snapshot().current.target).toEqual(homeTarget);
  driver.dispose();
});

it("retiring the pending return destination coalesces through skipped native entries", () => {
  const b = browser("", true);
  const driver = createBrowserHistory(b.host);
  driver.push(settings);
  const opener = driver.snapshot().current;
  driver.push({ ...settings, section: "profile" });
  const first = driver.snapshot().current;
  driver.push({ ...settings, section: "notifications" });
  const second = driver.snapshot().current;
  driver.dismiss([second.id], first.target);
  driver.dismiss([first.id], opener.target);
  expect(b.pending()).toBe(1);
  b.flush(); // The first traversal reaches a now-retired entry.
  expect(b.pending()).toBe(1);
  driver.dismiss([first.id, second.id], opener.target);
  expect(b.pending()).toBe(1);
  b.flush();
  expect(driver.snapshot().current).toEqual(opener);
  expect(driver.snapshot().canGoForward).toBe(false);
  driver.dispose();
});

it("completes a bounced dismissal after replacement so later dialogs can close", () => {
  const b = browser("", true);
  const driver = createBrowserHistory(b.host);
  const home = driver.snapshot().current;
  const channel = {
    version: 1,
    kind: "page",
    pluginId: "test",
    pageId: "channel",
  } as const;
  driver.push(channel);
  const opener = driver.snapshot().current;
  driver.push(settings);
  driver.dismiss([driver.snapshot().current.id], channel);
  // Retiring every older entry replaces the current visit while its return
  // is already queued. The native traversal must skip, then bounce here.
  driver.dismiss([opener.id, home.id], channel);
  const replacement = driver.snapshot().current;
  expect(replacement.target).toEqual(channel);
  expect(b.pending()).toBe(1);
  b.flush();
  expect(b.pending()).toBe(1);
  b.flush();
  expect(b.pending()).toBe(0);
  expect(driver.snapshot().current).toEqual(replacement);
  driver.push(settings);
  driver.dismiss([driver.snapshot().current.id], channel);
  expect(b.pending()).toBe(1);
  b.flush();
  expect(driver.snapshot().current).toEqual(replacement);
  expect(driver.snapshot().canGoBack).toBe(false);
  expect(driver.snapshot().canGoForward).toBe(false);
  driver.dispose();
});

it("a late hashchange cannot release the next dismissal's pending traversal", () => {
  const b = browser("", true);
  const driver = createBrowserHistory(b.host);
  driver.push({
    version: 1,
    kind: "page",
    pluginId: "test",
    pageId: "channel",
  });
  const opener = driver.snapshot().current;
  driver.push(settings);
  let reopened = false;
  driver.attach(() => {
    if (reopened || driver.snapshot().current.id !== opener.id) return;
    reopened = true;
    // The new close starts during popstate publication, before the previous
    // traversal's hashchange. That duplicate must not unlock another go().
    driver.push(settings);
    driver.dismiss([driver.snapshot().current.id], opener.target);
  });
  driver.dismiss([driver.snapshot().current.id], opener.target);
  b.flush();
  expect(reopened).toBe(true);
  expect(driver.snapshot().current.target).toEqual(settings);
  driver.dismiss([driver.snapshot().current.id], opener.target);
  expect(b.pending()).toBe(1);
  b.flush();
  expect(driver.snapshot().current).toEqual(opener);
  expect(driver.snapshot().canGoForward).toBe(false);
  driver.dispose();
});

it("bounds browser return paths and metadata to 100 visits, including native traversal and reload", () => {
  const fixture = browser();
  const driver = createBrowserHistory(fixture.host);
  for (let i = 0; i < 150; i++)
    driver.push({ ...settings, section: `section-${i}` });
  expect(driver.snapshot().retainedVisits).toHaveLength(100);
  fixture.host.history.go(-149);
  expect(driver.snapshot().current.target).toEqual({
    ...settings,
    section: "section-50",
  });
  expect(driver.snapshot().canGoBack).toBe(false);
  driver.dispose();
  const restored = createBrowserHistory(fixture.host);
  expect(restored.snapshot().retainedVisits).toHaveLength(100);
  fixture.host.history.back();
  expect(restored.snapshot().current.target).toEqual({
    ...settings,
    section: "section-50",
  });
  restored.dispose();
});

it("guards asynchronous native traversal without losing the presentation or its return path", () => {
  const fixture = browser("", true);
  const host = createNavigationController(createBrowserHistory(fixture.host));
  const nav = host.navigation;
  void nav.open(settings);
  const original = nav.snapshot().attempt;
  let decide: ((proceed: boolean) => void) | undefined;
  host.guardDeparture((_next, decision) => {
    decide = decision;
    return true;
  });
  fixture.host.history.back();
  expect(nav.snapshot().attempt).toBe(original);
  expect(original.signal.aborted).toBe(false);
  decide?.(true); // Even before the bounce has reached Settings again.
  fixture.flush();
  fixture.flush();
  expect(nav.snapshot().entry.target).toEqual(homeTarget);
  expect(original.signal.aborted).toBe(true);
  host.dispose();
});
