// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InstructionsMarkdown } from "./InstructionsMarkdown";
afterEach(cleanup);
it("renders Markdown structure and reference links without executing HTML or unsafe URLs", () => {
  const { container } = render(
    <InstructionsMarkdown
      text={
        "# Instructions\n\n**Report** blockers and use `check`.\n\n- Read [the PR][pr]\n\n[pr]: https://github.com/example/project/pull/1\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n![Diagram](https://example.com/private.png)"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Instructions" })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("Report");
  expect(container.querySelector("code")?.textContent).toBe("check");
  expect(
    screen.getByRole("link", { name: "the PR" }).getAttribute("href"),
  ).toBe("https://github.com/example/project/pull/1");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("Diagram")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
});
