// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Recovery } from "./builderlab-account";
import { KeyRestore } from "./KeyRestore";
import type { RecoveryState } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
afterEach(cleanup);

const linked = "a".repeat(64);
const other = "b".repeat(64);
function recovery(state: RecoveryState, canceled = true) {
  return {
    subscribe: () => () => {},
    snapshot: () => state,
    beginRecovery: vi.fn(async () => {}),
    installRecovery: vi.fn(async () => {}),
    cancelRecovery: vi.fn(async () => canceled),
  } satisfies Recovery;
}
function mount(state: RecoveryState, canceled?: boolean) {
  const stub = recovery(state, canceled);
  render(
    <KeyRestore
      recovery={stub}
      expectedPubkey={linked}
      onBack={() => {}}
      onImport={() => {}}
      onInstalled={() => {}}
    />,
  );
  return stub;
}
const unmatched = (failedCount: number): RecoveryState => ({
  status: "choosing",
  candidates: [{ handle: "h1", pubkey: other }],
  currentPubkey: null,
  failedCount,
});

it("when every backup came back and none holds the linked key, offers only Enter your private key", () => {
  mount(unmatched(0));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "None of your backups holds the key linked to this account, so nothing was restored.",
  );
  expect(
    screen.getByRole("button", { name: "Enter your private key" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Try recovery again" }),
  ).toBeNull();
  expect(
    screen.queryByText("Your key is stored securely on this device."),
  ).toBeNull();
});

it("when a backup failed to come back, does not claim none holds the key and retries over the live attempt", async () => {
  const stub = mount(unmatched(1));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Some of your backups couldn’t be recovered, and the ones that were don’t hold the key linked to this account.",
  );
  expect(
    screen.getByRole("button", { name: "Enter your private key" }),
  ).toBeEnabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Try recovery again" }),
  );
  // The service refuses a new attempt over one that recovered something:
  // the retry cancels first, then begins.
  await waitFor(() => expect(stub.beginRecovery).toHaveBeenCalledTimes(1));
  expect(stub.cancelRecovery).toHaveBeenCalledTimes(1);
  expect(stub.cancelRecovery.mock.invocationCallOrder).toEqual([
    expect.any(Number),
  ]);
  const [cancelOrder] = stub.cancelRecovery.mock.invocationCallOrder;
  const [beginOrder] = stub.beginRecovery.mock.invocationCallOrder;
  expect(cancelOrder).toBeLessThan(beginOrder ?? -1);
});

it("starts no new attempt when the live one could not be canceled", async () => {
  const stub = mount(unmatched(1), false);
  await userEvent.click(
    screen.getByRole("button", { name: "Try recovery again" }),
  );
  await waitFor(() => expect(stub.cancelRecovery).toHaveBeenCalledTimes(1));
  expect(stub.beginRecovery).not.toHaveBeenCalled();
});
