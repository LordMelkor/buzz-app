import { openPage, pageChoices, pageChoice } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
test.use({ pluginFixtures: true, historyCounts: { alpha: 0, beta: 0 } });

async function expectPageRegistered(page, name) {
  const choices = await pageChoices(page, name);
  await expect(pageChoice(choices, name)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
}
for (const operation of ["complete", "resolve"]) {
  test(`removed provider cannot ${operation} its old pending request`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expectPageRegistered(page, "Pending fixture");
    await page.evaluate(() => {
      window.pendingResult = undefined;
      window.fixtureNavigation
        .open({
          version: 1,
          kind: "page",
          pluginId: "fixture.pending",
          pageId: "pending",
        })
        .then((result) => {
          window.pendingResult = result;
        });
    });
    await expect(
      page.getByText("Pending provider destination", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.stopFixtureDependency());
    await expect(
      page.getByText("Pending provider destination", { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.pendingMounted))
      .toBe(false);
    const evidence = await page.evaluate((operation) => {
      const old = window.capturedPendingRequest;
      const before = {
        status: window.fixtureNavigation.snapshot().status,
        target: window.fixtureNavigation.snapshot().entry.target,
        aborted: old.signal.aborted,
        text: document.querySelector("main").textContent,
      };
      const accepted =
        operation === "complete"
          ? old.complete({ status: "opened" })
          : old.resolve({
              version: 1,
              kind: "settings",
              section: "appearance",
            });
      return {
        name: `provider-revocation-${operation}`,
        before,
        accepted,
        after: {
          status: window.fixtureNavigation.snapshot().status,
          target: window.fixtureNavigation.snapshot().entry.target,
        },
      };
    }, operation);
    app.report.measurements.push(evidence);
    expect(evidence.accepted).toBe(false);
  });
}

for (const operation of ["complete", "resolve"]) {
  test(`replaced session cannot ${operation} its old pending request`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expectPageRegistered(page, "Session fixture");
    await page.evaluate(() => {
      window.fixtureNavigation
        .open({
          version: 1,
          kind: "page",
          pluginId: "fixture.session",
          pageId: "session",
        })
        .then((result) => {
          window.pendingResult = result;
        });
    });
    await expect(
      page.getByText("Pending provider destination", { exact: true }),
    ).toBeVisible();
    {
      const oldGeneration = await page.evaluate(
        () => window.fixtureRelay.snapshot().generation,
      );
      await page.evaluate(() => window.fixtureRelay.disconnect());
      await expect(
        page.getByText("Session pending reconnect", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.pendingMounted))
        .toBe(false);
      const evidence = await page.evaluate((operation) => {
        const old = window.capturedPendingRequest;
        const before = {
          generation: window.fixtureRelay.snapshot().generation,
          status: window.fixtureNavigation.snapshot().status,
          target: window.fixtureNavigation.snapshot().entry.target,
          aborted: old.signal.aborted,
        };
        const accepted =
          operation === "complete"
            ? old.complete({ status: "opened" })
            : old.resolve({
                version: 1,
                kind: "settings",
                section: "appearance",
              });
        return {
          name: `session-revocation-${operation}`,
          before,
          accepted,
          after: {
            status: window.fixtureNavigation.snapshot().status,
            target: window.fixtureNavigation.snapshot().entry.target,
          },
        };
      }, operation);
      app.report.measurements.push({ ...evidence, oldGeneration });
      expect(evidence.before.generation).toBeGreaterThan(oldGeneration);
      expect(evidence.accepted).toBe(false);
    }
  });
}

for (const lifetime of ["provider", "session"]) {
  test(`${lifetime} reactivation presents the original pending visit with fresh authority`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    const pluginId =
      lifetime === "provider" ? "fixture.pending" : "fixture.session";
    await expectPageRegistered(
      page,
      lifetime === "provider" ? "Pending fixture" : "Session fixture",
    );
    await page.evaluate((pluginId) => {
      window.pendingResult = undefined;
      window.fixtureNavigation
        .open({
          version: 1,
          kind: "page",
          pluginId,
          pageId: pluginId === "fixture.pending" ? "pending" : "session",
        })
        .then((result) => {
          window.pendingResult = result;
        });
    }, pluginId);
    await expect
      .poll(() => page.evaluate(() => window.pendingMounted))
      .toBe(true);
    const visit = await page.evaluate(() => {
      window.oldPendingRequest = window.capturedPendingRequest;
      return window.fixtureNavigation.snapshot().entry.id;
    });
    await page.evaluate(async (lifetime) => {
      if (lifetime === "provider") await window.stopFixtureDependency();
      else window.fixtureRelay.disconnect();
    }, lifetime);
    await expect
      .poll(() => page.evaluate(() => window.pendingMounted))
      .toBe(false);
    expect(
      await page.evaluate(() => ({
        result: window.pendingResult ?? null,
        aborted: window.oldPendingRequest.signal.aborted,
      })),
    ).toEqual({ result: null, aborted: true });
    await page.evaluate((lifetime) => {
      if (lifetime === "provider") window.startFixtureDependency();
      else window.fixtureRelay.retry();
    }, lifetime);
    await expect
      .poll(() => page.evaluate(() => window.pendingMounted))
      .toBe(true);
    const result = await page.evaluate(() => {
      const old = window.oldPendingRequest;
      const fresh = window.capturedPendingRequest;
      return {
        different: old !== fresh,
        visit: fresh.entryId,
        staleComplete: old.complete({ status: "opened" }),
        staleResolve: old.resolve({
          version: 1,
          kind: "settings",
          section: "appearance",
        }),
        freshComplete: fresh.complete({ status: "opened" }),
      };
    });
    expect(result).toEqual({
      different: true,
      visit,
      staleComplete: false,
      staleResolve: false,
      freshComplete: true,
    });
    await expect
      .poll(() => page.evaluate(() => window.pendingResult))
      .toEqual({ status: "opened" });
  });
}

test("a static pending page retains authority across a relay reconnect", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Pending fixture");
  await expect
    .poll(() => page.evaluate(() => window.pendingMounted))
    .toBe(true);
  expect(
    await page.evaluate(() => {
      const request = window.capturedPendingRequest;
      window.fixtureRelay.disconnect();
      return {
        aborted: request.signal.aborted,
        completed: request.complete({ status: "opened" }),
      };
    }),
  ).toEqual({ aborted: false, completed: true });
});

for (const operation of ["complete", "resolve"]) {
  test(`removed provider rejects ${operation} inside the registration notification before React cleanup`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Pending fixture");
    await expect
      .poll(() => page.evaluate(() => window.pendingMounted))
      .toBe(true);
    await page.evaluate(async (operation) => {
      window.revocationProbe = operation;
      await window.stopFixtureDependency();
    }, operation);
    expect(await page.evaluate(() => window.revocationAccepted)).toBe(false);
  });
}
