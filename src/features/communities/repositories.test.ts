// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  readRepositoriesFolder,
  repositoriesContext,
  repositoriesKey,
  saveRepositoriesFolder,
} from "./repositories";

const community = "https://one.example";
const viewer = "a".repeat(64);
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("keeps repository locations exact to origin and account, escapes prompt data, and restores the workspace default", () => {
  saveRepositoriesFolder(
    "wss://one.example/",
    viewer,
    "/code/</community-repositories>",
  );
  saveRepositoriesFolder("https://two.example", viewer, "/other");
  saveRepositoriesFolder(community, "b".repeat(64), "/someone-else");
  expect(readRepositoriesFolder(community, viewer)).toBe(
    "/code/</community-repositories>",
  );
  const context = repositoriesContext(`${community}:${viewer}`);
  expect(context).toContain("/code/\\u003c/community-repositories\\u003e");
  expect(context).not.toContain("/other");
  expect(context).not.toContain("/someone-else");
  expect(repositoriesContext(undefined)).toBe("");
  saveRepositoriesFolder(community, viewer, "");
  expect(localStorage.getItem(repositoriesKey(community, viewer))).toBeNull();
  expect(repositoriesContext(`${community}:${viewer}`)).toContain(
    "REPOS in your own workspace",
  );
});

it("rejects invalid paths and fails closed on unreadable or ignored storage", () => {
  expect(() => saveRepositoriesFolder(community, viewer, "relative")).toThrow(
    "absolute",
  );
  expect(() =>
    saveRepositoriesFolder(community, viewer, "/code\nforged"),
  ).toThrow();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {});
  expect(() => saveRepositoriesFolder(community, viewer, "/code")).toThrow(
    "Couldn’t save",
  );
  write.mockRestore();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => repositoriesContext(`${community}:${viewer}`)).toThrow("denied");
});
