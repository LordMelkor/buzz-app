import { pauseClock } from "./clock.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import {
  open,
  settle,
  upper,
  expectAnchor,
  end,
  edge,
  anchor,
} from "./timeline.mjs";

test.use({
  productionBroker: true,
  historyCounts: { alpha: 640, beta: 20 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const notice = (page) =>
  page.getByRole("status", { name: "Reconnecting to relay…", exact: true });
const retry = (page) =>
  notice(page).getByRole("button", { name: "Retry now", exact: true });
/** Retry now if the notice still shows; automatic recovery may close it first. */
const retryIfShown = (page) =>
  retry(page)
    .click({ timeout: 500 })
    .catch(() => {});
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter["#h"]?.length === 1 &&
      filter["#h"][0] === channel &&
      filter.top_level === true &&
      filter.until === undefined,
  );
/** Cross a quota cooldown in controlled time. The app starts its own deadline
 * when it consumes the refusal, which precedes the visible error and ignored
 * clicks; advancing the page clock by the full delay from here passes it. The
 * broker's lane uses real time, so also wait for its exact reopening. */
async function crossCooldown(page, app) {
  // The broker's lane reopens in real time. Wait for it before the paused page
  // clock passes the app's deadline: a queued automatic retry sends at once,
  // and a second refusal would arm a new deadline that the clock never passes.
  await expect.poll(() => app.relay.brokerCooldownOver()).toBe(true);
  await page.clock.runFor(app.relay.rejected[0].retryAfterMs);
}
/** Cross a quota cooldown in real time, for a page whose timeline must keep
 * the browser's own clock. The app arms its deadline when it consumes the
 * refusal, after the broker paused its lane and the fixture stamped the
 * response, so the broker's reopening is the earliest useful moment and only
 * the page knows the last one. Clicks before it are ignored, as asserted
 * before the crossing. Automatic recovery sends the catch-up on its own;
 * Retry now only shortens the wait, and a click while that request is in
 * flight only promotes it. */
async function retryAfterCooldown(page, app, sent) {
  await expect.poll(() => app.relay.brokerCooldownOver()).toBe(true);
  await expect
    .poll(
      async () => {
        if (!sent()) await retryIfShown(page);
        return sent();
      },
      { message: "Retry after the quota cooldown sends the catch-up" },
    )
    .toBe(true);
}
async function ready(page, app) {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  // The first head may already start after stream establishment; a duplicate
  // initial read is not required. Recovery below has its own positive gap control.
  await expect.poll(() => heads(app, "alpha").length).toBeGreaterThanOrEqual(1);
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await expect(notice(page)).toHaveCount(0);
  await settle(page);
}

test("production WS → broker → mounted UI delivers messages and retries a paused catch-up without replacing healthy routes", async ({
  page,
  app,
}) => {
  // The first roster renews the activity observer and retires presence, which
  // re-subscribes after its read gate. Either control may wait behind one in
  // flight until that fetch's own continuation sends it, so count controls in
  // the page: settlement and any resend fall in one microtask checkpoint.
  await page.addInitScript(() => {
    const native = window.fetch;
    window.liveControls = 0;
    window.fetch = (input, init) => {
      const result = native(input, init);
      if (/\/stream-(observer|presence-authors)$/.test(String(input))) {
        const settled = () => window.liveControls--;
        window.liveControls++;
        result.then(settled, settled);
      }
      return result;
    };
  });
  // A running page clock behaves like real time until the cooldown below
  // pauses it.
  await page.clock.install();
  await ready(page, app);
  const live = app.append("primary", "alpha", "Policy-realistic live delivery");
  await expect(
    history(page).locator(`[data-message-id="${live.id}"]`),
  ).toBeInViewport();
  const reading = await upper(page);
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .fill("Keep my draft");
  const established = (kind) =>
    app.relay.sockets.some(
      ({ community, readyState, routes }) =>
        community === "primary" &&
        readyState === 1 &&
        [...routes].some(
          ([id, filters]) =>
            filters.some((filter) => filter.kinds.includes(kind)) &&
            app.report.wireFrames.some(
              (frame) => frame[0] === "EOSE" && frame[1] === id,
            ),
        ),
    );
  // The broker applies each control before it responds. Once the page has
  // handled every response, live observer and presence routes that reached
  // EOSE belong to the latest generations.
  await expect
    .poll(
      async () =>
        !(await page.evaluate(() => window.liveControls)) &&
        established(24200) &&
        established(20001),
    )
    .toBe(true);
  const socketCount = app.relay.sockets.length;
  const globalRequests = app.relay.requests.filter(({ filters }) =>
    filters.every((filter) => !filter["#h"]),
  ).length;
  // The app arms its cooldown when it consumes the refusal, and the ignored
  // clicks below must land before that deadline. Pause the page clock before
  // the failure and step it in 250 ms slices: the clicks then land within
  // 250 ms of page time after the 3 s notice delay, inside the 6 s cooldown.
  await pauseClock(page, 1000);
  const step = (done) =>
    expect
      .poll(async () => (await done()) || void (await page.clock.runFor(250)), {
        intervals: [50],
      })
      .toBe(true);
  app.relay.failRoute("primary", "alpha");
  const missed = app.append(
    "primary",
    "alpha",
    "Delivered by authoritative catch-up",
    false,
  );
  app.relay.quotaNextHead("alpha", 6);
  // A sidebar preview may reach the shared broker before the selected head.
  // It must not consume the failure injected specifically for head catch-up.
  const previewStatus = await page.evaluate(async () => {
    const response = await fetch("/api/relay/primary/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Buzz-Read-Priority": "background",
      },
      body: JSON.stringify([
        {
          "#h": ["alpha", "beta"],
          include_aux: true,
          kinds: [40002, 9],
          limit: 500,
        },
      ]),
    });
    return response.status;
  });
  expect(previewStatus).toBe(200);
  expect(app.relay.rejected).toHaveLength(0);
  // No click: automatic recovery sends the head catch-up.
  await step(() => app.relay.rejected.length === 1);
  // The notice appears once recovery lasts 3 s (RECOVERY_NOTICE_DELAY_MS).
  await step(() => notice(page).isVisible());
  const calls = heads(app, "alpha").length;
  await retry(page).click();
  await retry(page).click();
  expect(heads(app, "alpha")).toHaveLength(calls);
  expect(app.relay.sockets).toHaveLength(socketCount);
  expect(
    app.relay.requests.filter(({ filters }) =>
      filters.every((filter) => !filter["#h"]),
    ),
  ).toHaveLength(globalRequests);
  // The timeline keeps the browser's own clock from here.
  await page.clock.resume();
  await expectAnchor(page, reading);
  await retryAfterCooldown(page, app, () => heads(app, "alpha").length > calls);
  await expect(notice(page)).toHaveCount(0);
  await expect.poll(() => heads(app, "alpha").length).toBe(calls + 1);
  await settle(page);
  await expectAnchor(page, reading);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toHaveJSProperty("value", "Keep my draft");
  await end(page);
  await expect(
    history(page).locator(`[data-message-id="${missed.id}"]`),
  ).toBeInViewport();
  const after = app.append("primary", "alpha", "Live delivery still active");
  await expect(
    history(page).locator(`[data-message-id="${after.id}"]`),
  ).toBeInViewport();
});

test("post-reconnect finite catch-up keeps paged history, cursor and reading position", async ({
  page,
  app,
}) => {
  await ready(page, app);
  await edge(page, -1);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  const before = await anchor(page);
  const pageOne = app.pending.shift();
  pageOne.release();
  await expect(
    history(page).locator(`[data-message-id="${pageOne.events[0].id}"]`),
  ).toBeAttached();
  await settle(page);
  await expectAnchor(page, before);
  const reading = await upper(page);
  const calls = heads(app, "alpha").length;
  app.relay.disconnect("primary");
  const missed = app.append(
    "primary",
    "alpha",
    "Reconnect gap repaired",
    false,
  );
  await expect.poll(() => heads(app, "alpha").length).toBeGreaterThan(calls);
  await expect(notice(page)).toHaveCount(0);
  await settle(page);
  await expectAnchor(page, reading);
  await edge(page, -1);
  await expect.poll(() => app.pending.length).toBe(1);
  const pageTwo = app.pending.shift();
  expect(pageTwo.filter.until).toBeLessThan(pageOne.filter.until);
  pageTwo.release();
  await end(page);
  await expect(
    history(page).locator(`[data-message-id="${missed.id}"]`),
  ).toBeInViewport();
});

test("automatic recovery restores an empty paused roster without restarting healthy global subscriptions", async ({
  page,
  app,
}) => {
  // Empty is a valid authoritative result: recovery must not depend on a
  // selected channel or on an interest change replacing the global stream.
  app.relay.emptyRoster();
  app.relay.quotaNextRoster(6);
  // The app arms its cooldown when it consumes the refusal, and the ignored
  // clicks below must land before that deadline. Navigation needs a running
  // page clock, so hold the first roster read until it is done, then pause the
  // clock before the refusal arms the deadline: only crossCooldown passes it.
  const roster = Promise.withResolvers();
  let rosterHeld = false;
  await page.route("**/api/relay/primary/query", async (route) => {
    if (
      !rosterHeld &&
      [route.request().postDataJSON()]
        .flat()
        .some((filter) => filter.kinds?.includes(39002))
    ) {
      rosterHeld = true;
      await roster.promise;
    }
    await route.fallback();
  });
  await page.clock.install();
  await page.goto(app.origin);
  try {
    await openPage(page, "Messages");
    await expect.poll(() => rosterHeld).toBe(true);
    await pauseClock(page, 1000);
  } finally {
    roster.resolve();
  }
  await expect.poll(() => app.relay.rejected.length).toBe(1);
  // The notice appears once recovery lasts 3 s (RECOVERY_NOTICE_DELAY_MS).
  // Run the paused clock only that far: the 6 s cooldown still holds, so the
  // ignored clicks below land before it ends.
  await page.clock.runFor(3_000);
  await expect(notice(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  const globals = () =>
    app.relay.requests.filter(({ filters }) =>
      filters.some(
        (filter) => filter.kinds.includes(0) || filter.kinds.includes(44100),
      ),
    );
  const observer = () =>
    app.relay.requests.filter(({ filters }) =>
      filters.some((filter) => filter.kinds.includes(24200)),
    );
  const presence = () =>
    app.relay.requests.filter(({ filters }) =>
      filters.some((filter) => filter.kinds.includes(20001)),
    );
  await expect.poll(() => globals().length).toBe(2);
  await expect.poll(() => observer().length).toBe(1);
  await expect.poll(() => presence().length).toBe(1);
  // Presence owns a separate access/demand-scoped route. Establish startup EOSE
  // before recording healthy chat wires; a roster error is not a stream barrier.
  const healthy = globals();
  await expect
    .poll(() =>
      [...healthy, ...presence(), ...observer()].every(({ id }) =>
        app.report.wireFrames.some(
          (frame) => frame[0] === "EOSE" && frame[1] === id,
        ),
      ),
    )
    .toBe(true);
  const sockets = app.relay.sockets.length;
  const rosters = () =>
    app.report.queries.filter(({ filter }) => filter.kinds?.includes(39002));
  const calls = rosters().length;
  await retry(page).click();
  await retry(page).click();
  expect(rosters()).toHaveLength(calls);
  await crossCooldown(page, app);
  await retryIfShown(page);
  await expect(
    page.getByText("No channels yet.", { exact: true }),
  ).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  expect(rosters()).toHaveLength(calls + 1);
  expect(app.relay.sockets).toHaveLength(sockets);
  // The first authoritative (empty) roster resets the access generation:
  // activity renews its live-only route. That lifecycle may not restart the
  // healthy profile/membership chat globals.
  await expect.poll(() => observer().length).toBe(2);
  await expect
    .poll(() =>
      app.report.wireFrames.some(
        (frame) => frame[0] === "EOSE" && frame[1] === observer()[1].id,
      ),
    )
    .toBe(true);
  expect(globals()).toHaveLength(2);
  for (const { socket, id } of healthy)
    expect(app.relay.sockets[socket].routes.has(id)).toBe(true);
  expect(observer()[1].filters[0].since).toBeGreaterThanOrEqual(
    observer()[0].filters[0].since,
  );
});
