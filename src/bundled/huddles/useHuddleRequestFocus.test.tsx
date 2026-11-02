// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useHuddleRequestFocus } from "./useHuddleRequestFocus";

afterEach(cleanup);
function Request({
  shown,
  error,
  initial = false,
}: {
  shown: boolean;
  error?: string;
  initial?: boolean;
}) {
  const focus = useHuddleRequestFocus(false, error, initial);
  return (
    <>
      <button type="button" aria-label="Search Buzz">
        Search
      </button>
      <textarea aria-label="Message" />
      {shown && (
        <section ref={focus.requestRef}>
          <button type="button" data-huddle-join="">
            Join
          </button>
          <button type="button" ref={focus.cancel}>
            Cancel
          </button>
        </section>
      )}
    </>
  );
}
it.each(["owned", "before", "after"])(
  "preserves retry focus ownership when focus moves %s teardown",
  (when) => {
    const view = render(<Request shown />);
    const editor = screen.getByRole("textbox");
    screen.getByRole("button", { name: "Cancel" }).focus();
    if (when === "before") editor.focus();
    view.rerender(<Request shown={false} />);
    if (when === "after") editor.focus();
    view.rerender(<Request shown error="Admission failed" />);
    expect(
      when === "owned" ? screen.getByRole("button", { name: "Join" }) : editor,
    ).toHaveFocus();
  },
);
it("gives a newly opened retry companion an initial Join target", () => {
  render(<Request shown error="Admission failed" initial />);
  expect(screen.getByRole("button", { name: "Join" })).toHaveFocus();
});
