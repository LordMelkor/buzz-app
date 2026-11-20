import { readFileSync } from "node:fs";
import { expect, test } from "./playwright-test.mjs";

const framePage = readFileSync(
  new URL("../../src-tauri/src/frame.html", import.meta.url),
  "utf8",
);
const policy = /const POLICY: &str =\s*"([^"]+)";/.exec(
  readFileSync(
    new URL("../../src-tauri/src/frame.rs", import.meta.url),
    "utf8",
  ),
)[1];
const unsandboxed = policy
  .split(";")
  .filter((directive) => !directive.trim().startsWith("sandbox"))
  .join(";");
const origin = "http://buzz-frame.test";

test.beforeEach(async ({ page }) => {
  await page.route(`${origin}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Host</title>",
      });
    return route.fulfill({
      contentType: "text/html",
      headers: {
        "Content-Security-Policy": pathname === "/same" ? unsandboxed : policy,
      },
      body: framePage,
    });
  });
});

test("writes only the first well-formed document its parent sends", async ({
  page,
}) => {
  await page.goto(`${origin}/`);
  const messages = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frame = document.createElement("iframe");
        const sibling = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        sibling.setAttribute("sandbox", "allow-scripts");
        frame.src = "/frame";
        const html = (label) =>
          `<script>parent.postMessage("written:${label}", "*");` +
          `addEventListener("message", (event) => { if (event.data === "probe") parent.postMessage("probe:${label}", "*"); });</script>`;
        const write = (label) => ({
          type: "buzz-frame:write",
          html: html(label),
        });
        const seen = [];
        addEventListener("message", (event) => {
          if (event.source === sibling.contentWindow) {
            const target = frame.contentWindow;
            target.postMessage(null, "*");
            target.postMessage(
              { type: "buzz-frame:other", html: html("wrong-type") },
              "*",
            );
            target.postMessage(
              { type: "buzz-frame:write", html: [html("not-a-string")] },
              "*",
            );
            target.postMessage(write("first"), "*");
            target.postMessage(write("second"), "*");
            target.postMessage("probe", "*");
            return;
          }
          if (event.source !== frame.contentWindow) return;
          seen.push(event.data);
          if (event.data?.type === "buzz-frame:ready") {
            const message = JSON.stringify(write("sibling")).replaceAll(
              "<",
              "\\u003c",
            );
            sibling.srcdoc = `<script>parent.frames[0].postMessage(${message}, "*"); parent.postMessage("sent", "*");</script>`;
            document.body.append(sibling);
          } else if (String(event.data).startsWith("probe:")) {
            resolve(seen);
          }
        });
        document.body.append(frame);
      }),
  );
  expect(messages).toEqual([
    { type: "buzz-frame:ready" },
    "written:first",
    "probe:first",
  ]);
});

test("does nothing in a frame that shares its parent's origin", async ({
  page,
}) => {
  await page.goto(`${origin}/`);
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.src = "/same";
        const seen = [];
        addEventListener("message", (event) => {
          if (event.source === frame.contentWindow) seen.push(event.data);
        });
        window.written = () => resolve({ written: true, seen });
        frame.addEventListener(
          "load",
          () => {
            const target = frame.contentWindow;
            target.addEventListener("message", (event) => {
              if (event.data === "done") resolve({ written: false, seen });
            });
            target.postMessage(
              {
                type: "buzz-frame:write",
                html: "<script>parent.written()</script>",
              },
              "*",
            );
            target.postMessage("done", "*");
          },
          { once: true },
        );
        document.body.append(frame);
      }),
  );
  expect(result).toEqual({ written: false, seen: [] });
});

test("does nothing as a top-level page with an opaque origin", async ({
  page,
}) => {
  await page.goto(`${origin}/top`);
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.written = () => resolve("written");
        addEventListener("message", (event) => {
          if (event.data === "done") resolve("ignored");
        });
        postMessage(
          { type: "buzz-frame:write", html: "<script>written()</script>" },
          "*",
        );
        postMessage("done", "*");
      }),
  );
  expect(result).toBe("ignored");
});
