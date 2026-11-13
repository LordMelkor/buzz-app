import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";
import { entityDecoderAlias } from "../../scripts/entity-decoder-alias.mjs";

let server;
let directory;
let url;

/** A small valid PDF with one line of Latin text per page, and optionally a
 * page of Japanese in a non-embedded font that needs a predefined CMap, or a
 * page with a drawn line and no text. */
function pdf(lines, { japanese = false, blank = false } = {}) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 6 0 R >>",
    "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  ];
  const kids = [];
  const page = (stream) => {
    kids.push(`${objects.length + 1} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  };
  for (const line of lines) page(`BT /F1 24 Tf 72 700 Td (${line}) Tj ET`);
  if (japanese) page("BT /F2 32 Tf 72 700 Td <65E5672C8A9E> Tj ET");
  if (blank) page("72 700 m 540 700 l S");
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const ORIGIN = "https://relay.example.org";
const SECTIONS = 80;
const LONG = `# Long notes\n\n${Array.from(
  { length: SECTIONS },
  (_, i) =>
    `## Section ${i + 1}\n\n${"The quick brown fox jumps over the lazy dog. ".repeat(20)}\n\n`,
).join("")}`;
const PHOTO = `${ORIGIN}/media/${"4".repeat(64)}.png`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMwTpuJFTEMLQkAyvtMgQDiJ6sAAAAASUVORK5CYII=",
  "base64",
);

const FILES = {
  a: [
    "text/markdown",
    "# Launch notes\n\nShip **Friday**.\n\n- [x] Draft\n- [ ] Review\n\n<img src=x onerror=alert(1)>\n",
  ],
  b: ["text/csv", 'name,role\nAda,"Engineer, lead"\nGrace,Admiral\n'],
  c: ["text/plain", 'fn main() {\n    println!("hi");\n}\n'],
  d: ["application/pdf", pdf(["First page", "Second page"])],
  f: ["application/pdf", pdf([], { japanese: true })],
  1: ["text/markdown", LONG],
  2: [
    "text/markdown",
    `# Pictures\n\n![Team photo](${PHOTO})\n\n![Remote chart](https://example.org/chart.png)\n`,
  ],
  3: ["application/pdf", pdf([], { blank: true })],
  "9a": [
    "text/html",
    `<!DOCTYPE html><html><head><title>Report</title><style>h1{color:rgb(200, 0, 0)}</style></head><body><h1>Quarterly report</h1><p><a href="#notes">Notes</a></p><img alt="Team photo" src="${PHOTO}"><img alt="Remote chart" src="https://example.org/chart.png"><div style="height:3000px"></div><h2 id="notes">Notes</h2><p>Signed off.</p></body></html>`,
  ],
  "9b": [
    "image/svg+xml",
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>',
  ],
  "9c": [
    "application/x-ipynb+json",
    JSON.stringify({
      cells: [
        {
          cell_type: "markdown",
          metadata: {},
          source: ["# Analysis\n", "The answer follows."],
        },
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          source: ["6 * 7"],
          outputs: [
            {
              output_type: "execute_result",
              execution_count: 1,
              metadata: {},
              data: { "text/plain": ["4242"] },
            },
          ],
        },
      ],
      metadata: { language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    }),
  ],
  "9d": ["text/plain", pdf(["Renamed page"])],
  4: ["image/png", PNG],
  ...Object.fromEntries(
    await Promise.all(
      [
        ["5", "foundation.docx"],
        ["6", "sheets-real.xlsx"],
        ["7", "pptx-python-pptx.pptx"],
        ["8", "iwork-native.pages"],
      ].map(async ([key, name]) => [
        key,
        [
          "application/octet-stream",
          await readFile(
            new URL(
              `../../src/bundled/file-viewer/fixtures/office/${name}`,
              import.meta.url,
            ),
          ),
        ],
      ]),
    ),
  ),
};

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-file-viewer-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    resolve: { alias: [entityDecoderAlias] },
    build: {
      rollupOptions: { input: join(root, "tests/browser/file-viewer.html") },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/file-viewer.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function serveMedia(page) {
  const requests = [];
  await page.route("**/api/relay/media?**", (route) => {
    const media = new URL(route.request().url()).searchParams.get("url") ?? "";
    requests.push(media);
    const hash = media.split("/").pop() ?? "";
    const file = FILES[hash.slice(0, 2)] ?? FILES[hash.slice(0, 1)];
    if (!file) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      status: 200,
      contentType: file[0],
      body: file[1],
    });
  });
  return requests;
}

for (const { name, width, theme, large } of [
  { name: "wide, light", width: 1280, theme: "light" },
  {
    name: "narrow, dark, enlarged text",
    width: 420,
    theme: "dark",
    large: true,
  },
]) {
  test(`opens shared files from their cards (${name})`, async ({ page }) => {
    const { unexplained } = watchPageErrors(page);
    const requests = await serveMedia(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${url}?theme=${theme}${large ? "&large" : ""}`);
    const message = page.getByRole("main", { name: "Message" });
    await expect(message.getByText("Not claimed: archive.zip")).toBeVisible();

    await message
      .getByRole("button", { name: /notes\.md/ })
      .first()
      .click();
    const viewer = page.getByRole("complementary", { name: "File viewer" });
    await expect(
      viewer.getByRole("heading", { name: "Launch notes", level: 1 }),
    ).toBeVisible();
    await expect(viewer.getByText("Friday")).toBeVisible();
    await expect(viewer.getByRole("checkbox")).toHaveCount(2);
    await expect(viewer.locator("img")).toHaveCount(0);

    await message
      .getByRole("button", { name: /rows\.csv/ })
      .first()
      .click();
    await expect(
      viewer.getByRole("columnheader", { name: "role" }),
    ).toBeVisible();
    await expect(
      viewer.getByRole("cell", { name: "Engineer, lead" }),
    ).toBeVisible();

    await message
      .getByRole("button", { name: /main\.rs/ })
      .first()
      .click();
    await expect(viewer.getByText('println!("hi");')).toBeVisible();

    await message
      .getByRole("button", { name: /guide\.pdf/ })
      .first()
      .click();
    await expect(viewer.getByText("Page 1 of 2")).toBeVisible();
    const first = viewer.getByRole("img", { name: "Page 1 of 2" });
    await expect(first.locator("canvas")).toBeVisible();
    await expect
      .poll(() =>
        first.locator("canvas").evaluate((canvas) => {
          const context = canvas.getContext("2d");
          const { data } = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          );
          let ink = 0;
          for (let i = 0; i < data.length; i += 4)
            if (data[i + 3] > 0 && data[i] < 128) ink++;
          return ink;
        }),
      )
      .toBeGreaterThan(50);
    await viewer.getByRole("button", { name: "Next page" }).click();
    await expect(viewer.getByText("Page 2 of 2")).toBeVisible();
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    await expect(
      viewer.getByRole("button", { name: "Fit to width" }),
    ).toBeEnabled();

    expect(
      requests.every((media) => media.startsWith(`${ORIGIN}/media/`)),
    ).toBe(true);
    // The viewer scrolls wide pages inside itself, never sideways past its pane.
    expect(
      await viewer.evaluate((pane) => pane.scrollWidth - pane.clientWidth),
    ).toBeLessThanOrEqual(0);
    expect(unexplained()).toEqual([]);
  });
}

test("explains a file that can't be loaded", async ({ page }) => {
  await page.route("**/api/relay/media?**", (route) =>
    route.fulfill({ status: 500, body: "" }),
  );
  await page.goto(url);
  await page
    .getByRole("main", { name: "Message" })
    .getByRole("button", { name: /notes\.md/ })
    .first()
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "File viewer" })
      .getByText(/couldn't be loaded/),
  ).toBeVisible();
});

test("draws a PDF that needs a bundled CMap, without leaving the app", async ({
  page,
}) => {
  const { unexplained } = watchPageErrors(page);
  await serveMedia(page);
  const assets = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (/\.(bcmap|pfb|ttf|wasm)$/.test(path))
      assets.push([path.split("/").pop(), response.status()]);
  });
  await page.goto(`${url}?extra=japanese`);
  await page
    .getByRole("main", { name: "Message" })
    .getByRole("button", { name: /japanese\.pdf/ })
    .first()
    .click();
  const viewer = page.getByRole("complementary", { name: "File viewer" });
  await expect(viewer.getByText("Page 1 of 1")).toBeVisible();
  await expect
    .poll(() => assets.find(([name]) => name.startsWith("UniJIS-UCS2-H")))
    .toEqual([expect.stringMatching(/\.bcmap$/), 200]);
  expect(unexplained()).toEqual([]);
});

async function openFile(page, extra, name) {
  await page.goto(`${url}?extra=${extra}`);
  await page
    .getByRole("main", { name: "Message" })
    .getByRole("button", { name: new RegExp(name.replace(".", "\\.")) })
    .first()
    .click();
  return page.getByRole("complementary", { name: "File viewer" });
}

test("reads a long file in parts, and jumps into one not yet shown without moving", async ({
  page,
}) => {
  const { unexplained } = watchPageErrors(page);
  await serveMedia(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const viewer = await openFile(page, "long", "long.md");
  const scroller = viewer.getByRole("region", { name: "long.md" });
  const heading = (n) =>
    viewer.getByRole("heading", { name: `Section ${n}`, exact: true });
  await expect(heading(1)).toBeVisible();
  await expect(heading(45)).toHaveCount(0);

  // The outline lists the whole file, drawing only the rows around its view.
  await viewer.getByRole("button", { name: "Outline" }).click();
  const outline = page.getByRole("navigation", { name: "Outline" });
  await expect(outline.getByRole("listitem").first()).toHaveAttribute(
    "aria-setsize",
    String(SECTIONS + 1),
  );
  await outline.evaluate((nav) => {
    nav.scrollTop = (nav.scrollHeight * 45) / 81;
  });
  await outline
    .getByRole("button", { name: "Section 45", exact: true })
    .click();
  await expect(outline).toBeHidden();
  await expect(heading(45)).toBeInViewport();
  const offset = (locator) =>
    locator.evaluate(
      (node) =>
        node.getBoundingClientRect().top -
        node.closest("section").getBoundingClientRect().top,
    );
  expect(Math.abs(await offset(heading(45)))).toBeLessThanOrEqual(1);

  // Opened again, the outline starts at the section in view.
  await viewer.getByRole("button", { name: "Outline" }).click();
  const here = outline.getByRole("button", { name: "Section 45", exact: true });
  await expect(here).toHaveAttribute("aria-current", "location");
  await expect(here).toBeInViewport();
  // The keyboard reaches rows that aren't drawn. A key with a modifier is
  // left to the browser.
  await here.focus();
  await page.keyboard.press("Shift+End");
  await expect(here).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    outline.getByRole("button", { name: `Section ${SECTIONS}`, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    outline.getByRole("button", { name: "Long notes", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(outline).toBeHidden();

  // Scrolling up to the start of the first part shown adds the part before it
  // above: what's in view stays where it was. Noted in the same task as the
  // scroll, before the buffer can see it.
  const { first, before } = await scroller.evaluate((node) => {
    const part = node.querySelector("[data-part]");
    const top = (element) =>
      element.getBoundingClientRect().top - node.getBoundingClientRect().top;
    node.scrollTop += top(part) + 40;
    const seen = part.querySelector("h2");
    seen.dataset.seen = "";
    return { first: Number(part.dataset.part), before: top(seen) };
  });
  expect(first).toBeGreaterThan(0);
  await expect(viewer.locator(`[data-part="${first - 1}"]`)).toHaveCount(1);
  expect(
    Math.abs((await offset(viewer.locator("[data-seen]"))) - before),
  ).toBeLessThanOrEqual(1);

  // Scrolling on reads the parts after it, to the end of the file.
  await expect
    .poll(async () => {
      await scroller.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      return heading(SECTIONS).count();
    })
    .toBe(1);
  expect(unexplained()).toEqual([]);
});

test("draws a community image in Markdown, and a remote one as its alt text", async ({
  page,
}) => {
  const { unexplained } = watchPageErrors(page);
  const requests = await serveMedia(page);
  const remote = [];
  await page.route("https://example.org/**", (route) => {
    remote.push(route.request().url());
    return route.abort();
  });
  const viewer = await openFile(page, "pictures", "pictures.md");
  const photo = viewer.getByRole("img", { name: "Team photo" });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((img) => img.complete && img.naturalWidth))
    .toBe(8);
  await expect(viewer.getByText("Remote chart")).toBeVisible();
  await expect(viewer.locator("img")).toHaveCount(1);
  expect(requests).toContain(PHOTO);
  expect(remote).toEqual([]);
  expect(unexplained()).toEqual([]);
});

test("says a PDF without text has none to copy", async ({ page }) => {
  const { unexplained } = watchPageErrors(page);
  await serveMedia(page);
  const viewer = await openFile(page, "blank", "blank.pdf");
  await expect(viewer.getByText("Page 1 of 1")).toBeVisible();
  await viewer.getByRole("button", { name: "Copy text" }).click();
  await expect(page.getByText("No text to copy")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Copy text" })).toBeEnabled();
  expect(unexplained()).toEqual([]);
});

test("opens Office files in their own chunk, only once one is opened", async ({
  page,
}) => {
  const { unexplained } = watchPageErrors(page);
  await serveMedia(page);
  const scripts = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  const office = () => scripts.filter((script) => /OfficeView/.test(script));
  const viewer = await openFile(page, "word", "notes.md");
  await expect(
    viewer.getByRole("heading", { name: "Launch notes" }),
  ).toBeVisible();
  expect(office()).toEqual([]);
  await page
    .getByRole("main", { name: "Message" })
    .getByRole("button", { name: /foundation\.docx/ })
    .click();
  await expect(viewer.getByText("Office foundation").first()).toBeVisible();
  expect(office()).toHaveLength(1);
  expect(unexplained()).toEqual([]);
});

for (const [extra, name, shows] of [
  [
    "excel",
    "budget.xlsx",
    (viewer) => viewer.getByRole("cell", { name: "25%" }).first(),
  ],
  [
    "powerpoint",
    "review.pptx",
    (viewer) => viewer.getByText("Quarterly review").first(),
  ],
  [
    "pages",
    "brochure.pages",
    (viewer) =>
      viewer.getByRole("img", { name: "First page of brochure.pages" }),
  ],
]) {
  test(`opens ${name}`, async ({ page }) => {
    const { unexplained } = watchPageErrors(page);
    await serveMedia(page);
    const viewer = await openFile(page, extra, name);
    await expect(shows(viewer)).toBeVisible();
    expect(unexplained()).toEqual([]);
  });
}

test("draws an HTML page with community images only, its links and its source", async ({
  page,
}) => {
  const { unexplained } = watchPageErrors(page);
  const requests = await serveMedia(page);
  const remote = [];
  await page.route("https://example.org/**", (route) => {
    remote.push(route.request().url());
    return route.abort();
  });
  const viewer = await openFile(page, "page", "report.html");
  await expect(
    viewer.getByText(/^HTML · \d+ min read · \d+ words$/),
  ).toBeVisible();
  const frame = viewer.frameLocator('iframe[title="report.html"]');
  const heading = frame.getByRole("heading", { name: "Quarterly report" });
  await expect(heading).toHaveCSS("color", "rgb(200, 0, 0)");
  const photo = frame.getByRole("img", { name: "Team photo" });
  await expect
    .poll(() => photo.evaluate((img) => img.complete && img.naturalWidth))
    .toBe(8);
  expect(requests).toContain(PHOTO);
  await frame.getByRole("link", { name: "Notes" }).click();
  await expect(frame.getByRole("heading", { name: "Notes" })).toBeInViewport();
  expect(remote).toEqual([]);

  await viewer.getByRole("tab", { name: "Source" }).click();
  await expect(viewer.locator("iframe")).toHaveCount(0);
  await expect(
    viewer.getByText("<h1>Quarterly report</h1>", { exact: false }),
  ).toBeVisible();
  await viewer.getByRole("tab", { name: "Page" }).click();
  await expect(heading).toBeVisible();
  expect(unexplained()).toEqual([]);
});

test("draws an SVG file as a picture, with its source a tab away", async ({
  page,
}) => {
  const { unexplained } = watchPageErrors(page);
  await serveMedia(page);
  const viewer = await openFile(page, "picture", "logo.svg");
  const picture = viewer.getByRole("img", { name: "logo.svg" });
  await expect
    .poll(() => picture.evaluate((img) => img.complete && img.naturalWidth))
    .toBe(40);
  await viewer.getByRole("tab", { name: "Source" }).click();
  await expect(viewer.getByText("<rect", { exact: false })).toBeVisible();
  expect(unexplained()).toEqual([]);
});

for (const [extra, name, shows] of [
  [
    "notebook",
    "analysis.ipynb",
    (viewer) => viewer.getByText("4242", { exact: true }),
  ],
  ["renamed", "scan.txt", (viewer) => viewer.getByText("Page 1 of 1")],
]) {
  test(`opens ${name}`, async ({ page }) => {
    const { unexplained } = watchPageErrors(page);
    await serveMedia(page);
    const viewer = await openFile(page, extra, name);
    await expect(shows(viewer)).toBeVisible();
    expect(unexplained()).toEqual([]);
  });
}
