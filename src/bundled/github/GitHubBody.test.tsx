// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  MAX_MARKDOWN_LENGTH,
  MAX_MARKDOWN_DEPTH,
} from "../../features/relay/message-content";
import { GitHubBody } from "./GitHubBody";
import { GitHubPanel } from "./index";

const url = "https://github.com/block/buzz-app/pull/327";
const before =
  "https://github.com/user-attachments/assets/81e77cff-0e61-4694-9a88-add0c1f997e4";
const after =
  "https://github.com/user-attachments/assets/dd1f7e4f-e2a4-4aec-b661-cb45032f29c5";
const image =
  "https://github.com/user-attachments/assets/cd0773ee-9861-46d9-8a0f-352ae951ec7f";
const audio = "https://github.com/user-attachments/files/123/recording.wav";
const metadata = `<details><summary>before.mp4</summary><video src="https://private-user-images.githubusercontent.com/1888043/659873452-81e77cff-0e61-4694-9a88-add0c1f997e4.mp4?jwt=expired"></video></details><video><source src="${after}" /></video>`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders GFM and Before/After players without duplicate loaded-media links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`# Summary\n\n**Strong** and *emphasis* with [context](../328).\n\n- item\n- [x] done\n\n> quote\n\n| State | Result |\n| --- | --- |\n| Old | New |\n\n## Before\n\n${before}\n\n## After\n\n[Result recording](${after})`}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Summary", level: 1 }),
  ).toBeVisible();
  expect(container.querySelector("strong")).toHaveTextContent("Strong");
  expect(container.querySelector("em")).toHaveTextContent("emphasis");
  expect(screen.getByRole("link", { name: "context" })).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/328",
  );
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("table")).toHaveTextContent("StateResultOldNew");
  expect(container.querySelector("blockquote")).toHaveTextContent("quote");
  expect(
    [...container.querySelectorAll("h2, video")].map((node) =>
      node.tagName === "VIDEO" ? node.getAttribute("src") : node.textContent,
    ),
  ).toEqual(["Before", before, "After", after]);
  expect(
    screen.getByRole("link", { name: "Result recording" }),
  ).toHaveAttribute("href", after);
  for (const video of container.querySelectorAll("video")) {
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video.closest("p, a")).toBeNull();
    fireEvent.loadedData(video);
  }
  expect(screen.queryByRole("link", { name: before })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Result recording" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Result recording")).toBeVisible();
});

it("selects images, audio and named attachments while retaining descriptions and file links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={`<a href="${after}">capture.mov</a><audio src="${audio}"></audio>`}
      body={`![Screen description](${image})\n\n<img width="120" alt="HTML image" src="${image}" onerror="alert(1)">\n\n[Audio recording](${audio})\n\n[Movie](${after})\n\n[Archive](https://github.com/user-attachments/files/99/source.zip)`}
    />,
  );
  expect(screen.getByAltText("Screen description")).toHaveAttribute(
    "src",
    image,
  );
  expect(screen.getByAltText("HTML image")).not.toHaveAttribute("onerror");
  expect(container.querySelector("audio")).toHaveAttribute("src", audio);
  expect(container.querySelector("video")).toHaveAttribute("src", after);
  expect(screen.getByRole("link", { name: "Archive" })).toHaveAttribute(
    "href",
    "https://github.com/user-attachments/files/99/source.zip",
  );
  const audioElement = container.querySelector("audio");
  const videoElement = container.querySelector("video");
  if (!audioElement || !videoElement) throw new Error("Missing media");
  fireEvent.loadedData(audioElement);
  fireEvent.loadedData(videoElement);
  fireEvent.load(screen.getByAltText("Screen description"));
  for (const name of ["Screen description", "Audio recording", "Movie"])
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Archive" })).toBeVisible();
  fireEvent.error(audioElement);
  fireEvent.error(videoElement);
  fireEvent.error(screen.getByAltText("Screen description"));
  expect(screen.getByText("Audio unavailable")).toBeVisible();
  expect(screen.getByText("Video unavailable")).toBeVisible();
  expect(screen.getByText("Image unavailable")).toBeVisible();
  for (const [name, href] of [
    ["Screen description", image],
    ["Audio recording", audio],
    ["Movie", after],
  ] as const) {
    expect(screen.getByRole("link", { name })).toBeVisible();
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    expect(screen.getByRole("link", { name })).toHaveAttribute(
      "target",
      "_blank",
    );
  }
});

it.each(["Markdown", "HTML"])(
  "%s images preserve alt text without loaded captions",
  (syntax) => {
    for (const alt of ["Image", "Settings showing notifications enabled", ""]) {
      const { container, unmount } = render(
        <GitHubBody
          url={url}
          body={
            syntax === "Markdown"
              ? `Before ![${alt}](${image}) after.`
              : `<div>Before <img src="${image}" alt="${alt}"> after.</div>`
          }
        />,
      );
      const preview = screen.getByAltText(alt);
      expect(preview).toHaveAttribute("alt", alt);
      expect(screen.getByRole("link")).toHaveAttribute("href", image);
      fireEvent.load(preview);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(container).toHaveTextContent(/^Before after\.$/);
      fireEvent.error(preview);
      expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
      expect(screen.getByRole("link")).toHaveAttribute("href", image);
      unmount();
    }
  },
);

it.each([
  ["Result screenshot", "Result screenshot"],
  ["**Result *with `details`*** screenshot", "Result with details screenshot"],
  ["", "Attachment preview"],
])(
  "describes image previews and fullscreen from link label %s",
  (label, description) => {
    const source = "https://github.com/user-attachments/files/99/result.png";
    const { container } = render(
      <GitHubBody
        url={url}
        body={`See [${label}](${source}) for the result.`}
      />,
    );
    const preview = screen.getByAltText(description);
    expect(screen.getByRole("link")).toHaveAttribute("href", source);
    fireEvent.load(preview);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container).toHaveTextContent(
      `See ${label ? description : ""} for the result.`.replace(/ +/g, " "),
    );
    if (label.includes("**")) {
      expect(container.querySelector("strong")).toHaveTextContent(
        "Result with details",
      );
      expect(container.querySelector("em code")).toHaveTextContent("details");
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Open image fullscreen" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByAltText(description),
    ).toHaveAttribute("src", source);
    fireEvent.click(
      screen.getByRole("button", { name: "Close fullscreen viewer" }),
    );
    fireEvent.error(preview);
    expect(screen.getByRole("link")).toHaveAttribute("href", source);
  },
);

it("keeps original links when media fails before loading", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`${before}\n\n![Screenshot](${image})\n\n[Audio](${audio})`}
    />,
  );
  for (const media of container.querySelectorAll("video, img, audio"))
    fireEvent.error(media);
  expect(screen.getAllByRole("status")).toHaveLength(3);
  for (const [name, href] of [
    [before, before],
    ["Screenshot", image],
    ["Audio", audio],
  ] as const) {
    expect(screen.getByRole("link", { name })).toBeVisible();
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  }
});

it("preserves HTML-only summaries, prose and file links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        '<details><summary>Supporting evidence</summary><p>Read the logs &amp; notes.</p><a href="../files/report.zip">Download report</a></details>'
      }
    />,
  );
  expect(container).toHaveTextContent(
    "Supporting evidence Read the logs & notes. Download report",
  );
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/files/report.zip",
  );
  expect(container.querySelector("details, summary")).toBeNull();
});

it("keeps mixed HTML text, images and attachment links in order after loading and failure", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={`<div><p>Before the screenshot.</p><img src="${image}" alt="HTML screenshot" onerror="alert(1)"><p>After the screenshot.</p><a href="https://github.com/user-attachments/files/99/source.zip">Source archive</a></div>`}
    />,
  );
  const screenshot = screen.getByAltText("HTML screenshot");
  expect(screenshot).toHaveAttribute("src", image);
  expect(screenshot).not.toHaveAttribute("onerror");
  expect(container).toHaveTextContent(
    "Before the screenshot. HTML screenshot After the screenshot. Source archive",
  );
  fireEvent.load(screenshot);
  expect(screen.queryByRole("link", { name: "HTML screenshot" })).toBeNull();
  fireEvent.error(screenshot);
  expect(screen.getByRole("link", { name: "HTML screenshot" })).toHaveAttribute(
    "href",
    image,
  );
  expect(container).toHaveTextContent("Before the screenshot.");
  expect(container).toHaveTextContent("After the screenshot.");
  expect(screen.getByRole("link", { name: "Source archive" })).toHaveAttribute(
    "href",
    "https://github.com/user-attachments/files/99/source.zip",
  );
});

it.each([
  `<video src="${before}">Recording fallback</video>`,
  `<video><source src="${before}">Recording fallback</video>`,
  `<audio src="${before}">Recording fallback</audio>`,
])(
  "retains raw media destinations without requiring API metadata: %s",
  (body) => {
    const { container } = render(<GitHubBody url={url} body={body} />);
    expect(screen.getByRole("link", { name: before })).toHaveAttribute(
      "href",
      before,
    );
    expect(container).toHaveTextContent("Recording fallback");
  },
);

it("preserves HTML link labels while rejecting unsafe destinations and attributes", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        '<div onclick="alert(1)"><a href="javascript:alert(1)">Unsafe action</a><a href="data:text/html,bad">Unsafe data</a><a href="https://user:password@example.com/file">Credential URL</a><a href="https://example.com/report.zip" onclick="alert(1)">Safe file</a></div>'
      }
    />,
  );
  for (const label of ["Unsafe action", "Unsafe data", "Credential URL"])
    expect(container).toHaveTextContent(label);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Safe file" })).toHaveAttribute(
    "href",
    "https://example.com/report.zip",
  );
  expect(container.querySelector("[onclick]")).toBeNull();
});

it("keeps inline HTML anchor labels linked within surrounding prose", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={'See <a href="https://example.com/docs">the docs</a> now.'}
    />,
  );
  expect(container).toHaveTextContent("See the docs now.");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
    "href",
    "https://example.com/docs",
  );
});

it("separates adjacent HTML table header and data cells", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        "<table><tr><th>Before</th><th>After</th></tr><tr><td>old</td><td>new</td></tr></table>"
      }
    />,
  );
  expect(container).toHaveTextContent("Before After");
  expect(container).toHaveTextContent("old new");
});

it("preserves single line breaks alongside paragraphs, lists and code blocks", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        "First requirement.\nSecond requirement.\nThird requirement.\n\nSeparate paragraph.\n\n- one\n- two\n\n```\nline one\nline two\n```"
      }
    />,
  );
  const code = container.querySelector("pre code");
  expect(code).toHaveTextContent(/line one\s+line two/);
  expect(code?.querySelector("br")).toBeNull();
  expect(container.querySelectorAll("br")).toHaveLength(2);
  expect(screen.getByText(/First requirement\./).innerHTML).toMatch(
    /First requirement\.<br>.*Second requirement\.<br>.*Third requirement\./s,
  );
  expect(screen.getByText("Separate paragraph.")).toBeVisible();
  expect(
    [...container.querySelectorAll("li")].map((item) => item.textContent),
  ).toEqual(["one", "two"]);
});

it("preserves surrounding prose and formatted labels after an inline video loads", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`See [**the corrected behavior**](${before}) for the result.`}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video");
  fireEvent.loadedData(video);
  expect(container).toHaveTextContent("See");
  expect(container.querySelector("strong")).toHaveTextContent(
    "the corrected behavior",
  );
  expect(container).toHaveTextContent("for the result.");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("never interprets literal code or executes HTML and unsafe links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`\`${before}\`\n\n\`\`\`html\n<img src="${image}">\n${after}\n\`\`\`\n\n<script>alert(1)</script>\n\n<iframe src="https://evil.test"></iframe>\n\n[Bad](javascript:alert%281%29) ![Unsafe](data:image/svg+xml,bad)\n\n<img src="https://github.com.evil.test/image.png" alt="External">`}
    />,
  );
  expect(container.querySelectorAll("code")).toHaveLength(2);
  expect(container.querySelector("pre")).toHaveTextContent(after);
  expect(
    container.querySelector("script, iframe, video, img, audio"),
  ).toBeNull();
  expect(
    container.querySelector('a[href^="javascript:"], a[href^="data:"]'),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
    "href",
    "https://github.com.evil.test/image.png",
  );
});

it("does not guess UUID media types or match asset IDs embedded in unrelated paths", () => {
  const { container, rerender } = render(
    <GitHubBody url={url} body={before} />,
  );
  expect(container.querySelector("video")).toBeNull();
  expect(screen.getByRole("link")).toHaveAttribute("href", before);
  rerender(
    <GitHubBody
      url={url}
      body={before}
      bodyHtml='<video src="https://private-user-images.githubusercontent.com/1888043/prefix-81e77cff-0e61-4694-9a88-add0c1f997e4.mp4"></video>'
    />,
  );
  expect(container.querySelector("video")).toBeNull();
});

it.each([`![Linked image](${image})`, `**![Linked image](${image})**`])(
  "keeps linked Markdown images out of anchors and preserves both destinations: %s",
  (content) => {
    const { container } = render(
      <GitHubBody
        url={url}
        body={`[${content}](https://example.com/review)`}
      />,
    );
    expect(screen.getByAltText("Linked image").closest("a, p")).toBeNull();
    expect(screen.getByRole("link", { name: "Linked image" })).toHaveAttribute(
      "href",
      image,
    );
    expect(
      screen.getByRole("link", { name: "https://example.com/review" }),
    ).toBeVisible();
    fireEvent.load(screen.getByAltText("Linked image"));
    expect(
      screen.queryByRole("link", { name: "Linked image" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://example.com/review" }),
    ).toBeVisible();
    expect(container.querySelector("a a")).toBeNull();
  },
);

it("preserves linked HTML images and media fallback destinations without nested links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={`<div><a href="https://example.com/review"><img src="${image}" alt="Linked HTML image"></a><a href="https://example.com/recording"><video src="${before}">Recording</video></a></div>`}
    />,
  );
  expect(screen.getByAltText("Linked HTML image")).toHaveAttribute(
    "src",
    image,
  );
  for (const destination of [
    "https://example.com/review",
    "https://example.com/recording",
    before,
  ])
    expect(screen.getByRole("link", { name: destination })).toHaveAttribute(
      "href",
      destination,
    );
  expect(container.querySelector("a a, a img")).toBeNull();
});

it("preserves deeply nested HTML as literal text beyond the parsing budget", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={`${"<div>".repeat(MAX_MARKDOWN_DEPTH + 2)}Deep evidence<img src="${image}">${"</div>".repeat(MAX_MARKDOWN_DEPTH + 2)}`}
    />,
  );
  expect(container).toHaveTextContent(`Deep evidence<img src="${image}">`);
  expect(container.querySelector("img")).toBeNull();
});

it.each([
  "x".repeat(MAX_MARKDOWN_LENGTH + 1),
  `${"> ".repeat(MAX_MARKDOWN_DEPTH + 1)}deep`,
])("uses a literal fallback for over-budget Markdown", (body) => {
  const { container } = render(
    <GitHubBody url={url} body={body} bodyHtml={metadata} />,
  );
  expect(container.textContent).toBe(body);
  expect(container.querySelector("blockquote, video")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("ignores retired PR loads, retries errors, and clears media when navigating", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const retry = deferred<Response>();
  const fetch = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(retry.promise);
  vi.stubGlobal("fetch", fetch);
  const { container, rerender } = render(
    <GitHubPanel target={url} close={() => {}} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  rerender(<GitHubPanel target={`${url}0`} close={() => {}} />);
  // The store reads one batch at a time: the next PR is read once the
  // retired one's read is in.
  await act(async () => {
    first.resolve(
      new Response(
        JSON.stringify({
          title: "Retired PR",
          body: before,
          body_html: metadata,
        }),
      ),
    );
    await first.promise;
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("heading", { name: "Retired PR #327" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () => {
    second.resolve(new Response(null, { status: 400 }));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("400");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () => {
    retry.resolve(
      new Response(
        JSON.stringify({
          title: "Current PR",
          body: before,
          body_html: metadata,
        }),
      ),
    );
  });
  expect(
    screen.getByRole("heading", { name: "Current PR #3270" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Description" }),
  ).not.toBeInTheDocument();
  expect(container.querySelector("video")).toHaveAttribute("src", before);
  const next = deferred<Response>();
  fetch.mockReturnValueOnce(next.promise);
  rerender(<GitHubPanel target={`${url}1`} close={() => {}} />);
  expect(container.querySelector("video")).toBeNull();
  await act(async () => {
    next.resolve(
      new Response(JSON.stringify({ title: "No metadata", body: before })),
    );
  });
  expect(
    screen.getByRole("heading", { name: "No metadata #3271" }),
  ).toBeVisible();
  expect(container.querySelector("video")).toBeNull();
  expect(screen.getByRole("link", { name: before })).toBeVisible();
});
