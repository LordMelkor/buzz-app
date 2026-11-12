// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_RENDER_CHARS } from "../office-types";
import { readChart } from "./chart";
import { chartAdmission } from "./chart-admission";

const source = (title: string) =>
  new DOMParser().parseFromString(
    `<c:chartSpace xmlns:c="urn:chart" xmlns:a="urn:drawing"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>`,
    "application/xml",
  );

describe("document-wide chart admission", () => {
  it("keeps a terminal whole-chart prefix when rich-title extraction exceeds its bound", () => {
    const admit = chartAdmission(() => {}),
      first = source("Keep"),
      oversized = source("x".repeat(MAX_RENDER_CHARS + 1));
    const initial = admit(first, () => readChart(first));
    expect(initial).toMatchObject({ type: "line", title: "Keep" });
    expect(admit(oversized, () => readChart(oversized))).toBeUndefined();
    // Once the file is full, even a cached small chart cannot re-enter it.
    expect(admit(first, () => readChart(first))).toBeUndefined();
  });
});
