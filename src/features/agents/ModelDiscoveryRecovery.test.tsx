// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelDiscoveryRecovery } from "./ModelDiscoveryRecovery";

afterEach(cleanup);
it("does not reclaim focus when the person moves away during recovery", async () => {
  const retry = vi.fn();
  const content = (loading: boolean, error?: string) => (
    <>
      <ModelDiscoveryRecovery loading={loading} error={error} retry={retry}>
        <button type="button">Model</button>
      </ModelDiscoveryRecovery>
      <button type="button">Elsewhere</button>
    </>
  );
  const view = render(content(false, "offline"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  view.rerender(content(true));
  await user.keyboard("{Enter}");
  expect(retry).toHaveBeenCalledTimes(1);
  await user.tab();
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  view.rerender(content(false));
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});
