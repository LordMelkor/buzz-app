import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseXml } from "./xml";
import { presetGeometry, slideGeometry } from "./slide-geometry";
// Owner: geometry parser. These are external DrawingML path/formula contracts;
// the table exercises every supported preset, not a list of implementation exports.
describe("DrawingML geometry", () => {
  // Independent expected bounds at 200×100pt, calculated from the published
  // ECMA preset definitions (POI pinned in the data source), not this evaluator.
  const rectangles: readonly (readonly [
    string,
    readonly number[] | undefined,
  ])[] = [
    ["rect", [0, 0, 200, 100]],
    ["roundRect", [4.88159763, 4.88159763, 195.11840237, 95.11840237]],
    ["snip1Rect", [0, 8.3335, 191.6665, 100]],
    ["round1Rect", [0, 0, 195.11840237, 100]],
    ["ellipse", [29.289321881, 14.644660941, 170.710678119, 85.355339059]],
    ["triangle", [50, 50, 150, 100]],
    ["rtTriangle", [200 / 12, 700 / 12, 1400 / 12, 1100 / 12]],
    ["diamond", [50, 25, 150, 75]],
    ["parallelogram", [325 / 12, 325 / 24, 2075 / 12, 2075 / 24]],
    ["trapezoid", [50 / 3, 25 / 3, 550 / 3, 100]],
    ["pentagon", [38.196731862, 23.606737771, 161.803268138, 99.999745924]],
    ["hexagon", [25, 12.5, 175, 87.5]],
    ["octagon", [14.6445, 14.6445, 185.3555, 85.3555]],
    ["homePlate", [0, 0, 175, 100]],
    ["chevron", [50, 0, 150, 100]],
    ["plus", [0, 25, 200, 75]],
    ["star5", [61.804080799, 38.196772907, 138.195919201, 76.39267586]],
    ["rightArrow", [0, 25, 175, 75]],
    ["leftArrow", [25, 25, 200, 75]],
    ["upArrow", [50, 25, 150, 100]],
    ["downArrow", [50, 0, 150, 75]],
    ["leftRightArrow", [25, 25, 175, 75]],
    ["line", undefined],
    ..."straightConnector1 bentConnector2 bentConnector3 bentConnector4 bentConnector5 curvedConnector3 wedgeRectCallout flowChartProcess"
      .split(" ")
      .map((name) => [name, [0, 0, 200, 100]] as const),
    [
      "wedgeRoundRectCallout",
      [4.88159763, 4.88159763, 195.11840237, 95.11840237],
    ],
    [
      "cloud",
      [
        (200 * 2977) / 21600,
        (100 * 3262) / 21600,
        (200 * 17087) / 21600,
        (100 * 17337) / 21600,
      ],
    ],
    ["donut", [29.289321881, 14.644660941, 170.710678119, 85.355339059]],
    ["can", [0, 25, 200, 87.5]],
    ["flowChartAlternateProcess", [4.8815, 4.8815, 195.1185, 95.1185]],
    ["flowChartDecision", [50, 25, 150, 75]],
    [
      "flowChartTerminator",
      [
        (200 * 1018) / 21600,
        (100 * 3163) / 21600,
        (200 * 20582) / 21600,
        (100 * 18437) / 21600,
      ],
    ],
    ["flowChartDocument", [0, 0, 200, (100 * 17322) / 21600]],
    [
      "flowChartConnector",
      [29.289321881, 14.644660941, 170.710678119, 85.355339059],
    ],
  ];
  it.each(rectangles)(
    "evaluates %s paths and its specified text rectangle",
    (name, expected) => {
      const result = presetGeometry(name, 200, 100);
      if (name !== "rect") {
        expect(result?.path).toMatch(/^M/);
        expect(result?.path).toMatch(/^[MLCQA Z\d.-]+$/);
        expect(result?.path).not.toMatch(/NaN|Infinity|undefined/);
      }
      if (!expected) expect(result?.textRect).toBeUndefined();
      else
        for (const [index, side] of [
          "left",
          "top",
          "right",
          "bottom",
        ].entries())
          expect(
            result?.textRect?.[side as "left" | "top" | "right" | "bottom"],
          ).toBeCloseTo(required(expected[index]), 6);
    },
  );
  it("applies preset adjustment overrides rather than returning the default path", () => {
    const adjusted = presetGeometry(
      "roundRect",
      100,
      50,
      new Map([["adj", 25000]]),
    )?.path;
    expect(adjusted).toContain("A12.5 12.5");
    expect(presetGeometry("roundRect", 100, 50)?.path).toContain(
      "A8.3335 8.3335",
    );
    expect(presetGeometry("unknown", 100, 50)).toBeUndefined();
    expect(presetGeometry("rect", 100, 50)?.path).toBeUndefined();
  });
  it("maps custom lines, quadratic/cubic curves, guide formulas and full arcs exactly into box space", () => {
    const properties = parseXml(
      `<a:spPr xmlns:a="urn:drawing"><a:custGeom><a:avLst><a:gd name="adj" fmla="val 500"/></a:avLst><a:gdLst><a:gd name="x" fmla="*/ adj 2 1"/></a:gdLst><a:pathLst><a:path w="1000" h="1000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="x" y="0"/></a:lnTo><a:quadBezTo><a:pt x="500" y="500"/><a:pt x="0" y="1000"/></a:quadBezTo><a:cubicBezTo><a:pt x="0" y="500"/><a:pt x="500" y="0"/><a:pt x="1000" y="500"/></a:cubicBezTo><a:arcTo wR="500" hR="500" stAng="0" swAng="21600000"/><a:close/></a:path></a:pathLst></a:custGeom></a:spPr>`,
    ).documentElement;
    expect(slideGeometry(properties, 100, 50)?.path).toBe(
      "M0 0 L100 0 Q50 25 0 50 C0 25 50 0 100 25 A50 25 0 0 1 0 25 A50 25 0 0 1 100 25 Z",
    );
  });
  it("falls back safely for unknown guides and nonnumeric injected path operands", () => {
    const properties = parseXml(
      '<a:spPr xmlns:a="urn:drawing"><a:custGeom><a:avLst/><a:gdLst/><a:pathLst><a:path><a:moveTo><a:pt x="javascript:alert(1)" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom></a:spPr>',
    ).documentElement;
    expect(slideGeometry(properties, 100, 50)).toBeUndefined();
  });
});
