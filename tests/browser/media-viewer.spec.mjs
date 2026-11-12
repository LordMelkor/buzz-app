import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

/** A small valid PDF with one line of text per page. */
function pdf(lines) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${lines.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, line] of lines.entries()) {
    const stream = `BT /F1 24 Tf 72 700 Td (${line}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
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

const FILES = {
  a: [
    "text/markdown",
    "# Launch notes\n\nShip **Friday**.\n\n- [x] Draft\n- [ ] Review\n\n<img src=x onerror=alert(1)>\n",
  ],
  b: ["text/csv", 'name,role\nAda,"Engineer, lead"\nGrace,Admiral\n'],
  c: ["text/plain", 'fn main() {\n    println!("hi");\n}\n'],
  d: ["application/pdf", pdf(["First page", "Second page"])],
};

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-media-viewer-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: { input: join(root, "tests/browser/media-viewer.html") },
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/media-viewer.html`;
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
    const file = FILES[media.split("/").pop()?.[0] ?? ""];
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
    const viewer = page.getByRole("complementary", { name: "Media viewer" });
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
      requests.every((media) =>
        media.startsWith("https://relay.example.org/media/"),
      ),
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
      .getByRole("complementary", { name: "Media viewer" })
      .getByText(/couldn't be loaded/),
  ).toBeVisible();
});
