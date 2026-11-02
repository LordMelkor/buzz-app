// @vitest-environment jsdom
import { createElement } from "react";
import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BRAND_GRADIENTS } from "../../../../src/shared/design-system/tokens/brand";
import { BrandColors } from "./BrandColors";

it("shows artwork mappings without duplicating the palette ramps", () => {
  render(createElement(BrandColors));
  for (const gradient of BRAND_GRADIENTS)
    expect(
      screen.getByText(`${gradient.start} → ${gradient.end}`),
    ).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});
