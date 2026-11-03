import { test, expect } from "./fixture.mjs";
import { open, upper, anchor, expectAnchor } from "./timeline.mjs";

// Reading setup must not accidentally exercise older-page loading.
test.use({
  tallMessages: true,
  historyCounts: { alpha: 640, beta: 1 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

test("reading setup handles partial wheel progress without weakening the anchor", async ({
  page,
  app,
}) => {
  await open(page, app);
  const wheel = page.mouse.wheel.bind(page.mouse);
  let upwardGestures = 0;
  // Model partial input deterministically; every delivered gesture is still
  // real browser input through the production handlers, never a scrollTop write.
  page.mouse.wheel = (x, y) => {
    if (y < 0) upwardGestures++;
    return wheel(x, Math.max(-300, y));
  };
  try {
    const saved = await upper(page);
    expect(upwardGestures).toBeGreaterThan(1);
    expect(upwardGestures).toBeLessThanOrEqual(4);
    await expectAnchor(page, saved);
    expect(
      await history(page).evaluate(
        (el) => el.scrollTop - Math.max(3000, el.clientHeight * 4),
      ),
    ).toBeGreaterThan(0);
    expect(app.pending).toHaveLength(0);
  } finally {
    page.mouse.wheel = wheel;
  }
});

test("reading anchor handles clipped paragraphs and still detects displacement", async ({
  page,
}) => {
  // Deterministic geometry from the CI failure: both visible paragraphs are
  // clipped, with no whole paragraph to select. This is a helper control, not
  // a replacement for the production resize journeys.
  await page.setContent(`
    <section role="region" aria-label="Channel message history"
      style="position:fixed;top:100px;height:200px;width:400px;overflow:hidden">
      <div data-message-id="above" style="position:absolute;top:-100px">
        <p style="margin:0;height:50px">Offscreen</p>
      </div>
      <div data-message-id="clipped" style="position:absolute;top:-30px">
        <p style="margin:0;height:150px">Clipped at top</p>
      </div>
      <div data-message-id="next" style="position:absolute;top:130px">
        <p style="margin:0;height:150px">Clipped at bottom</p>
      </div>
    </section>
  `);
  const saved = await anchor(page);
  expect(saved).toEqual({ id: "clipped", y: -30 });
  await expectAnchor(page, saved);
  await page.locator('[data-message-id="clipped"]').evaluate((row) => {
    row.style.top = "-10px";
  });
  expect(await anchor(page)).toEqual({ id: saved.id, y: saved.y + 20 });
  // The unchanged oracle must reject a real jump, not merely find the same ID.
  await expect(expectAnchor(page, saved)).rejects.toThrow(
    "same visible message clipped at same viewport Y",
  );
  await page.locator('[data-message-id="next"] p').evaluate((p) => {
    p.style.height = "40px";
  });
  expect(await anchor(page)).toEqual({ id: "next", y: 130 });
  // A held row wins over that whole paragraph while any part of it is in
  // view; once out of view, the rules above apply again.
  expect(await anchor(page, "clipped")).toEqual({ id: "clipped", y: -10 });
  expect(await anchor(page, "above")).toEqual({ id: "next", y: 130 });
  await history(page)
    .locator("[data-message-id]")
    .evaluateAll((rows) => {
      for (const row of rows) row.style.top = "300px";
    });
  await expect(anchor(page)).rejects.toThrow("No visible message anchor");
});

test("reading anchor after a scroll reads at the scroll event, before later frames", async ({
  page,
}) => {
  await page.setContent(`
    <section role="region" aria-label="Channel message history"
      style="position:fixed;top:100px;height:200px;width:400px;overflow:auto">
      <div style="height:600px"></div>
      <div data-message-id="row" style="position:absolute;top:250px">
        <p style="margin:0;height:50px">Below until scrolled</p>
      </div>
    </section>
  `);
  // A later frame carries the row out of view, as a size batch can move rows.
  await history(page).evaluate((element) =>
    element.addEventListener(
      "scroll",
      () =>
        requestAnimationFrame(() => {
          element.querySelector("[data-message-id]").style.top = "400px";
        }),
      { once: true },
    ),
  );
  expect(await anchor(page, undefined, 100)).toEqual({ id: "row", y: 150 });
});

test("reading setup rejects an immobile timeline instead of accepting a bottom anchor", async ({
  page,
  app,
}) => {
  await open(page, app);
  await history(page).evaluate((element) => {
    element.addEventListener("wheel", (event) => event.preventDefault(), {
      passive: false,
    });
  });
  await expect(upper(page)).rejects.toThrow("timeline wheel gesture completes");
});

test("wheel setup drains a timed-out DOM read before returning its rejection", async ({
  page,
}) => {
  const { wheel } = await import("./timeline.mjs");
  await page.setContent(
    '<section role="region" aria-label="Channel message history" style="height:200px;overflow:auto"><div style="height:2000px"></div></section>',
  );
  await history(page).hover();
  const getByRole = page.getByRole.bind(page);
  const poll = expect.poll;
  const readStarted = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const pollEnded = Promise.withResolvers();
  let readFinished = false;
  let returned = false;
  page.getByRole = (...args) => {
    const locator = getByRole(...args);
    const evaluateHandle = locator.evaluateHandle.bind(locator);
    locator.evaluateHandle = async (...evaluateArgs) => {
      const handle = await evaluateHandle(...evaluateArgs);
      const evaluate = handle.evaluate.bind(handle);
      let first = true;
      handle.evaluate = async (...readArgs) => {
        if (first) {
          first = false;
          readStarted.resolve();
          await releaseRead.promise;
          const result = await evaluate(...readArgs);
          readFinished = true;
          return result;
        }
        return evaluate(...readArgs);
      };
      return handle;
    };
    return locator;
  };
  expect.poll = (callback, options) => {
    const matcher = poll(callback, { ...options, timeout: 100 });
    return {
      toBe: async (expected) => {
        try {
          return await matcher.toBe(expected);
        } finally {
          pollEnded.resolve();
        }
      },
    };
  };
  const outcome = wheel(page, -100).then(
    () => {
      returned = true;
    },
    (error) => {
      returned = true;
      return error;
    },
  );
  try {
    await readStarted.promise;
    await pollEnded.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      returned,
      "helper must not return while its DOM read is pending",
    ).toBe(false);
    releaseRead.resolve();
    const result = await outcome;
    expect(readFinished).toBe(true);
    expect(result?.message).toContain("timeline wheel gesture completes");
  } finally {
    releaseRead.resolve();
    await outcome;
    expect.poll = poll;
    page.getByRole = getByRole;
  }
});

// No app fixture: these controls exercise native input/scrollend ordering only.
test("wheel baseline waits through a geometry pause until the final input completes", async ({
  page,
}) => {
  const { wheel, settle } = await import("./timeline.mjs");
  await page.setContent(
    '<section role="region" aria-label="Channel message history" style="height:200px;overflow:auto"><div style="height:2000px"></div></section>',
  );
  await history(page).evaluate((element) => {
    window.heldScrollEnds = 0;
    window.holdScrollEnd = true;
    element.addEventListener("scrollend", (event) => {
      if (window.holdScrollEnd) {
        event.stopImmediatePropagation();
        window.heldScrollEnds++;
      }
    });
  });
  await history(page).hover();
  let finished = false;
  const outcome = wheel(page, 300).then(() => {
    finished = true;
  });
  try {
    await expect.poll(() => page.evaluate(() => window.heldScrollEnds)).toBe(1);
    // Geometry-only settling would return here: explicitly hold the final
    // movement, rather than hoping a slow machine produces a long enough pause.
    await settle(page);
    expect(finished, "stationary geometry is not completed input").toBe(false);
    await page.evaluate(() => {
      window.holdScrollEnd = false;
    });
    await page.mouse.wheel(0, 100);
    await outcome;
    expect(await history(page).evaluate((element) => element.scrollTop)).toBe(
      400,
    );
  } finally {
    await page.evaluate(() => {
      window.holdScrollEnd = false;
    });
    await history(page).dispatchEvent("scrollend");
    await outcome;
  }
});

test("wheel baseline rejects input blocked at the edge instead of accepting a stale completion", async ({
  page,
}) => {
  const { wheel } = await import("./timeline.mjs");
  await page.setContent(
    '<section role="region" aria-label="Channel message history" style="height:200px;overflow:auto"><div style="height:2000px"></div></section>',
  );
  await history(page).hover();
  const input = page.mouse.wheel.bind(page.mouse);
  page.mouse.wheel = async (...args) => {
    // A completion from before this gesture must not satisfy its observer.
    await history(page).dispatchEvent("scrollend");
    await input(...args);
  };
  try {
    await expect(wheel(page, -100)).rejects.toThrow(
      "timeline wheel gesture completes",
    );
    expect(await history(page).evaluate((element) => element.scrollTop)).toBe(
      0,
    );
    // Failure must remove its observer; a later ordinary gesture still works.
    await wheel(page, 100);
    expect(await history(page).evaluate((element) => element.scrollTop)).toBe(
      100,
    );
  } finally {
    page.mouse.wheel = input;
  }
});

test("upper waits for end's held final movement before capturing the reading anchor", async ({
  page,
}) => {
  const { settle } = await import("./timeline.mjs");
  await page.setContent(
    '<section role="region" aria-label="Channel message history" style="height:200px;overflow:auto"><div data-message-id="row" style="height:2000px"><p style="margin:0">Reading row</p></div></section>',
  );
  await history(page).evaluate((element) => {
    window.heldEnd = false;
    window.upwardGestures = 0;
    window.releaseEnd = () => {
      window.holdEnd = false;
      element.dispatchEvent(new Event("scrollend"));
    };
    window.holdEnd = true;
    element.addEventListener("wheel", (event) => {
      if (event.deltaY < 0) window.upwardGestures++;
    });
    element.addEventListener("scrollend", (event) => {
      if (window.holdEnd) {
        event.stopImmediatePropagation();
        window.heldEnd = true;
      }
    });
  });
  const input = page.mouse.wheel.bind(page.mouse);
  const poll = expect.poll;
  const waitingForCompletion = Promise.withResolvers();
  expect.poll = (callback, options) =>
    poll(async () => {
      const value = await callback();
      if (
        options?.message === "timeline wheel gesture completes" &&
        (await page.evaluate(() => window.heldEnd))
      )
        waitingForCompletion.resolve();
      return value;
    }, options);
  let first = true;
  page.mouse.wheel = (x, y) => {
    const distance = first ? y - 2 : y;
    first = false;
    return input(x, distance);
  };
  const outcome = upper(page);
  try {
    await expect.poll(() => page.evaluate(() => window.heldEnd)).toBe(true);
    // Observe the helper's wait, not just the browser's held event: otherwise
    // this negative check can beat upper's continuation even without the barrier.
    await waitingForCompletion.promise;
    await settle(page);
    expect(
      await page.evaluate(() => window.upwardGestures),
      "end must complete before upper reverses input",
    ).toBe(0);
    await page.evaluate(() => {
      window.holdEnd = false;
    });
    // Deliver the withheld 2px tail with real input; only then may upper reverse.
    await input(0, 2);
    const saved = await outcome;
    expect(saved).toEqual(await anchor(page));
    expect(await history(page).evaluate((element) => element.scrollTop)).toBe(
      1150,
    );
    expect(await page.evaluate(() => window.upwardGestures)).toBe(1);
  } finally {
    await page.evaluate(() => window.releaseEnd());
    try {
      await outcome;
    } finally {
      expect.poll = poll;
      page.mouse.wheel = input;
    }
  }
});
