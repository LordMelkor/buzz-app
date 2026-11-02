import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { watchPageErrors } from "../browser/page-errors.mjs";

// A Playwright page reduced to the events and browser identity the watcher reads.
const fakePage = (engine) => {
  const page = new EventEmitter();
  const mainFrame = {};
  page.mainFrame = () => mainFrame;
  page.context = () => ({
    browser: () => ({ browserType: () => ({ name: () => engine }) }),
  });
  return page;
};
const pageError = ({ name, message, stack }) =>
  Object.assign(new Error(message), { name, stack });
const cancel = (page, url, errorText = "Load request cancelled") =>
  page.emit("requestfailed", {
    url: () => url,
    failure: () => ({ errorText }),
  });

const query = "http://127.0.0.1:43347/api/relay/primary/query";
// Replayed from the Linux WebKit trace of navigation-repairs.spec.mjs:89 on main
// (run for 85d6bf82): Playwright split the console text at its first colon.
const reloadCancelLog = (url = query) =>
  pageError({
    name: "Fetch API cannot load http",
    message: `${url.slice("http:/".length)} due to access control checks.`,
    stack: `Fetch API cannot load ${url} due to access control checks.\n    at query (http://127.0.0.1:43347/assets/index.js:141:28966)`,
  });
const resizeObserverLoop = () =>
  pageError({
    name: "",
    message: "ResizeObserver loop completed with undelivered notifications.",
    stack: "",
  });

test("WebKit's log for a fetch the reload cancelled is kept as evidence but explained", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  assert.deepEqual(watched.errors, [
    `Fetch API cannot load ${query} due to access control checks.`,
  ]);
  assert.deepEqual(watched.unexplained(), []);
});

test("macOS WebKit's cancellation text is also a cancellation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query, "cancelled");
  page.emit("pageerror", reloadCancelLog());
  assert.deepEqual(watched.unexplained(), []);
});

test("the access-control log fails without a matching cancelled request", () => {
  for (const setup of [
    () => {},
    (page) => cancel(page, "http://127.0.0.1:43347/api/relay/primary/session"),
    (page) => cancel(page, query, "Could not connect to the server."),
  ]) {
    const page = fakePage("webkit");
    const watched = watchPageErrors(page);
    setup(page);
    page.emit("pageerror", reloadCancelLog());
    assert.equal(watched.unexplained().length, 1);
  }
});

// Replayed from the Linux WebKit trace of channel-archive-delete-pane.spec.mjs:28
// on main (run 37478134645 for 2bb37a55): a presence timer fired during the
// reload, and WebKit refused both fetches without a request event.
const presenceAuthors =
  "http://127.0.0.1:40091/api/relay/primary/stream-presence-authors";
const navigate = (page, frame = page.mainFrame()) => {
  const request = {
    isNavigationRequest: () => true,
    frame: () => frame,
    url: () => "http://127.0.0.1:40091/",
    failure: () => ({ errorText: "Load request cancelled" }),
  };
  page.emit("request", request);
  return request;
};

test("WebKit's log for a fetch refused while the document is replaced is explained", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const request = navigate(page);
  page.emit("pageerror", reloadCancelLog(presenceAuthors));
  page.emit("requestfinished", request);
  assert.deepEqual(watched.errors, [
    `Fetch API cannot load ${presenceAuthors} due to access control checks.`,
  ]);
  assert.deepEqual(watched.unexplained(), []);
});

// The old document's startup history.replaceState fires framenavigated while
// the navigation request is still in flight; the document is not replaced yet.
test("a same-document navigation does not end the pending navigation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  navigate(page);
  page.emit("framenavigated", page.mainFrame());
  page.emit("pageerror", reloadCancelLog(presenceAuthors));
  assert.deepEqual(watched.unexplained(), []);
});

test("another request finishing does not end the pending navigation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  navigate(page);
  page.emit("requestfinished", { url: () => presenceAuthors });
  page.emit("pageerror", reloadCancelLog(presenceAuthors));
  assert.deepEqual(watched.unexplained(), []);
});

test("only the main frame's pending navigation explains a refused fetch", () => {
  for (const setup of [
    // The new document has committed.
    (page) => page.emit("requestfinished", navigate(page)),
    // The new document loaded without its request reporting an outcome.
    (page) => {
      navigate(page);
      page.emit("domcontentloaded");
    },
    // The navigation failed, so the old document stays.
    (page) => page.emit("requestfailed", navigate(page)),
    // A child frame navigates.
    (page) => navigate(page, {}),
  ]) {
    const page = fakePage("webkit");
    const watched = watchPageErrors(page);
    setup(page);
    page.emit("pageerror", reloadCancelLog(presenceAuthors));
    assert.equal(watched.unexplained().length, 1);
  }
});

test("a pending navigation does not explain other page errors", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  navigate(page);
  page.emit("pageerror", new TypeError("a: b"));
  assert.deepEqual(watched.unexplained(), ["TypeError: a: b"]);
});

test("one cancellation explains one log", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  page.emit("pageerror", reloadCancelLog());
  assert.equal(watched.unexplained().length, 1);
});

test("a log during navigation uses up its cancellation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const request = navigate(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  page.emit("requestfinished", request);
  // The new document reports the same URL without a new cancellation.
  page.emit("pageerror", reloadCancelLog());
  assert.equal(watched.unexplained().length, 1);
});

test("an unhandled rejection is never an engine report", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit(
    "pageerror",
    pageError({
      name: "Unhandled Promise Rejection",
      message: "TypeError: Load failed",
      stack: "",
    }),
  );
  assert.deepEqual(watched.unexplained(), [
    "Unhandled Promise Rejection: TypeError: Load failed",
  ]);
});

test("engine reports are WebKit-only", () => {
  const page = fakePage("chromium");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  page.emit("pageerror", resizeObserverLoop());
  assert.equal(watched.unexplained().length, 2);
  const webkit = fakePage("webkit");
  const watchedWebkit = watchPageErrors(webkit);
  webkit.emit("pageerror", resizeObserverLoop());
  assert.deepEqual(watchedWebkit.unexplained(), []);
  assert.equal(watchedWebkit.errors.length, 1);
});

test("an application error keeps its name", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  page.emit("pageerror", new TypeError("a: b"));
  assert.deepEqual(watched.unexplained(), ["TypeError: a: b"]);
});
