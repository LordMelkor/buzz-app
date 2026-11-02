// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { agentAvatars } from "./avatar-packs";
import { AgentAvatarArtworkProvider } from "./AgentAvatarArtworkProvider";

afterEach(cleanup);

it("uses bundled static portraits for recognized pack URLs across avatar sizes", () => {
  const pack = agentAvatars[0];
  const next = agentAvatars[1];
  if (!pack || !next) throw new Error("Missing avatar fixtures");
  const avatars = (src: string) => (
    <AgentAvatarArtworkProvider>
      <Avatar src={src} alt="Agent in chat" fallback="Agent" size="small" />
      <Avatar
        src={pack.preview}
        alt="Agent in profile"
        fallback="Agent"
        size="large"
      />
    </AgentAvatarArtworkProvider>
  );
  const view = render(avatars(pack.url));
  for (const name of ["Agent in chat", "Agent in profile"]) {
    const avatar = view.getByRole("img", { name });
    expect(avatar.querySelector("video")).toBeNull();
    expect(avatar.querySelector("img")).toHaveAttribute("src", pack.preview);
    expect(avatar.querySelector("img")).toHaveAttribute("data-loaded", "true");
  }
  view.rerender(avatars(next.url));
  const chat = view.getByRole("img", { name: "Agent in chat" });
  expect(chat.querySelector("img")).toHaveAttribute("src", next.preview);
  expect(chat.querySelector("video")).toBeNull();
});

it("preserves ordinary image loading and fallback for unrecognized portraits", () => {
  const view = render(
    <AgentAvatarArtworkProvider>
      <Avatar
        src="https://example.test/person.png"
        alt="Person"
        fallback="Person"
      />
    </AgentAvatarArtworkProvider>,
  );
  const avatar = view.getByRole("img", { name: "Person" });
  const image = avatar.querySelector("img");
  if (!image) throw new Error("Missing ordinary image");
  expect(image).toHaveAttribute("src", "https://example.test/person.png");
  fireEvent.load(image);
  expect(image).toHaveAttribute("data-loaded", "true");
  fireEvent.error(image);
  expect(avatar).toHaveTextContent("P");
  expect(avatar.querySelector("img")).toBeNull();
});
