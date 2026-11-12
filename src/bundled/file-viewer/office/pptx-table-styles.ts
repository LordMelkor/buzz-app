/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Theme-relative PowerPoint built-in table styles (all 74 GUIDs).
// Derived from LibreOffice core 9d83595bbc85ee972633529086ed22382abdb8d2:
// oox/source/drawingml/table/predefined-table-styles.cxx (MPL-2.0).
// See pptx-table-styles.LICENSE and the fixture directory's extraction script.
// Deduplicated generated parts/templates retain scheme colours and transforms.
import { required } from "./required";
type Part = [
  string | null,
  number | null,
  string | null,
  Record<string, [string | null, number | null]>,
];
const PARTS: Part[] = [
  [
    "dk1",
    null,
    "@/tint:20000",
    {
      bottom: ["lt1", 12700],
      insideH: ["lt1", 12700],
      insideV: ["lt1", 12700],
      left: ["lt1", 12700],
      right: ["lt1", 12700],
      top: ["lt1", 12700],
    },
  ],
  ["lt1", 0, "@", { bottom: ["lt1", 12700] }],
  ["lt1", 0, "@", {}],
  ["lt1", null, "@", { top: ["lt1", null] }],
  [null, null, "@/tint:40000", {}],
  [null, null, null, {}],
  [
    "dk1",
    null,
    "@/tint:20000",
    {
      bottom: ["@", 12700],
      insideH: ["@", 12700],
      insideV: ["@", 12700],
      left: ["@", 12700],
      right: ["@", 12700],
      top: ["@", 12700],
    },
  ],
  ["@", 0, "@/tint:20000", {}],
  [null, 0, null, {}],
  [null, null, "dk1/tint:20000", {}],
  ["dk1", null, "@/tint:20000", {}],
  ["lt1", 0, "+", {}],
  [null, null, "@/tint:20000", { top: ["dk1", null] }],
  [
    "dk1",
    null,
    "dk1/tint:20000",
    {
      bottom: ["lt1", 12700],
      insideH: ["lt1", 12700],
      insideV: ["lt1", 12700],
      left: ["lt1", 12700],
      right: ["lt1", 12700],
      top: ["lt1", 12700],
    },
  ],
  ["lt1", 0, "dk1", { bottom: ["lt1", 12700] }],
  ["lt1", 0, "dk1", {}],
  ["lt1", null, "dk1", { top: ["lt1", null] }],
  [null, null, "dk1/tint:40000", {}],
  [
    "dk1",
    null,
    null,
    {
      bottom: ["@", 12700],
      insideH: ["@", 12700],
      insideV: ["@", 12700],
      left: ["@", 12700],
      right: ["@", 12700],
      top: ["@", 12700],
    },
  ],
  [
    "lt1",
    0,
    "@",
    {
      bottom: ["lt1", 12700],
      left: ["@", null],
      right: ["@", null],
      top: ["@", null],
    },
  ],
  [
    null,
    0,
    null,
    {
      bottom: ["@", null],
      insideH: ["@", null],
      left: ["@", null],
      right: ["@", null],
      top: ["@", null],
    },
  ],
  [
    null,
    null,
    null,
    {
      bottom: ["@", null],
      left: ["@", null],
      right: ["@", null],
      top: ["@", null],
    },
  ],
  [null, null, "@/alpha:40000", {}],
  ["tx1", null, null, { bottom: ["@", 12700], top: ["@", 12700] }],
  ["tx1", 1, null, { bottom: ["@", 12700] }],
  [null, 1, null, {}],
  [null, null, null, { top: ["@", null] }],
  ["tx1", 1, null, {}],
  [null, null, "@/alpha:20000", {}],
  [
    "dk1",
    null,
    "lt1",
    {
      bottom: ["@", 12700],
      insideH: ["@", 12700],
      left: ["@", 12700],
      right: ["@", 12700],
      top: ["@", 12700],
    },
  ],
  [null, null, "lt1", { top: ["@", null] }],
  [null, null, "@/tint:20000", {}],
  ["dk1", null, "@/shade:20000", {}],
  [null, 0, "@/shade:60000", { right: ["lt1", null] }],
  [null, null, "@", { top: ["lt1", null] }],
  [null, 0, "@/shade:60000", { left: ["lt1", null] }],
  [null, null, "@/shade:40000", {}],
  [
    "tx1",
    null,
    null,
    {
      bottom: ["@", 12700],
      left: ["@", 12700],
      right: ["@", 12700],
      top: ["@", 12700],
    },
  ],
  ["bg1", 0, "@", {}],
  [null, null, null, { bottom: ["@", null], top: ["@", null] }],
  [null, null, null, { left: ["@", null], right: ["@", null] }],
  [
    "lt1",
    null,
    null,
    {
      bottom: ["@/tint:50000", 12700],
      left: ["@/tint:50000", 12700],
      right: ["@/tint:50000", 12700],
      top: ["@/tint:50000", 12700],
    },
  ],
  ["lt1", 0, null, { bottom: ["lt1", 12700] }],
  [null, 0, null, { right: ["lt1", null] }],
  [null, null, null, { top: ["lt1", null] }],
  [null, 0, null, { left: ["lt1", null] }],
  [null, null, "lt1/alpha:20000", {}],
  ["dk1", null, "lt1", { bottom: ["dk1", 12700], top: ["dk1", 12700] }],
  ["lt1", 0, "@", { bottom: ["dk1", 12700] }],
  [null, null, "lt1", { top: ["dk1", null] }],
  ["tx1", null, null, {}],
  ["dk1", null, "dk1/tint:20000", {}],
  [null, null, "dk1/tint:20000", { top: ["dk1", null] }],
  [
    null,
    null,
    null,
    {
      bottom: ["tx1/tint:50000", 12700],
      insideH: ["tx1", 12700],
      insideV: ["tx1", 12700],
      left: ["tx1/tint:50000", 12700],
      right: ["tx1/tint:50000", 12700],
      top: ["tx1/tint:50000", 12700],
    },
  ],
  [
    "tx1",
    null,
    null,
    {
      bottom: ["@", 12700],
      insideH: ["@", 12700],
      insideV: ["@", 12700],
      left: ["@", 12700],
      right: ["@", 12700],
      top: ["@", 12700],
    },
  ],
  ["@", 0, null, { bottom: ["@", 12700] }],
  [
    "tx1",
    null,
    null,
    {
      bottom: ["tx1", 12700],
      insideH: ["tx1", 12700],
      insideV: ["tx1", 12700],
      left: ["tx1", 12700],
      right: ["tx1", 12700],
      top: ["tx1", 12700],
    },
  ],
  ["tx1", 0, null, { bottom: ["tx1", 12700] }],
  [null, null, null, { top: ["tx1", null] }],
  [null, null, "tx1/alpha:20000", {}],
  [
    "dk1",
    null,
    "lt1",
    {
      bottom: ["dk1", 12700],
      insideH: ["dk1", 12700],
      left: ["dk1", 12700],
      right: ["dk1", 12700],
      top: ["dk1", 12700],
    },
  ],
  [
    "tx1",
    null,
    null,
    {
      bottom: ["tx1", 12700],
      left: ["tx1", 12700],
      right: ["tx1", 12700],
      top: ["tx1", 12700],
    },
  ],
  ["bg1", 0, "tx1", {}],
  [null, null, null, { bottom: ["tx1", null], top: ["tx1", null] }],
  [null, null, null, { left: ["tx1", null], right: ["tx1", null] }],
  ["lt1", 0, "dk1", { bottom: ["dk1", 12700] }],
  ["tx1", null, null, { bottom: ["tx1", 12700], top: ["tx1", 12700] }],
  ["tx1", 1, null, { bottom: ["tx1", 12700] }],
  [
    "dk1",
    null,
    "dk1/tint:20000",
    {
      bottom: ["dk1", 12700],
      insideH: ["dk1", 12700],
      insideV: ["dk1", 12700],
      left: ["dk1", 12700],
      right: ["dk1", 12700],
      top: ["dk1", 12700],
    },
  ],
  ["dk1", 0, "dk1/tint:20000", {}],
  [null, 0, "dk1/tint:60000", { right: ["lt1", null] }],
  [null, null, "dk1", { top: ["lt1", null] }],
  [null, 0, "dk1/tint:60000", { left: ["lt1", null] }],
];
const TEMPLATES: [string | null, ...number[]][] = [
  [null, 0, 1, 2, 3, 2, 4, 4, 5, 5],
  [null, 6, 7, 8, 9, 8, 4, 4, 5, 5],
  [null, 10, 11, 8, 12, 8, 4, 4, 5, 5],
  [null, 13, 14, 15, 16, 15, 17, 17, 5, 5],
  [null, 18, 19, 20, 21, 20, 22, 22, 5, 5],
  [null, 23, 24, 25, 26, 27, 28, 28, 5, 5],
  [null, 29, 2, 8, 30, 8, 31, 31, 5, 5],
  [null, 32, 14, 33, 34, 35, 36, 36, 5, 5],
  [null, 37, 38, 8, 26, 8, 39, 40, 5, 40],
  ["@", 41, 42, 43, 44, 45, 46, 46, 5, 5],
  [null, 47, 48, 2, 49, 2, 9, 9, 5, 5],
  [null, 50, 8, 8, 5, 8, 5, 5, 5, 5],
  [null, 51, 15, 8, 52, 8, 17, 17, 5, 5],
  [null, 53, 8, 8, 5, 8, 5, 5, 5, 5],
  [null, 54, 55, 8, 26, 8, 28, 28, 5, 5],
  [null, 56, 57, 8, 58, 8, 59, 59, 5, 5],
  [null, 60, 15, 8, 49, 8, 9, 9, 5, 5],
  [null, 61, 62, 8, 58, 8, 63, 64, 5, 64],
  [null, 47, 65, 15, 49, 15, 9, 9, 5, 5],
  [null, 66, 67, 25, 58, 27, 59, 59, 5, 5],
  [null, 68, 69, 8, 9, 8, 17, 17, 5, 5],
  [null, 51, 14, 70, 71, 72, 17, 17, 5, 5],
];
const IDS: [string, number, number][] = [
  ["{00A15C55-8517-42AA-B614-E9B94910E393}", 0, 4],
  ["{0505E3EF-67EA-436B-97B2-0124C06EBD24}", 1, 3],
  ["{0660B408-B3CF-4A94-85FC-2B1E0A45F4A2}", 2, 1],
  ["{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", 3, 0],
  ["{08FB837D-C827-4EFA-A057-4D05807E0F7C}", 4, 6],
  ["{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}", 5, 2],
  ["{10A1B5D5-9B99-4C35-A422-299274C87663}", 6, 6],
  ["{125E5076-3810-47DD-B79F-674D7AD40C01}", 7, 1],
  ["{16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4}", 1, 6],
  ["{17292A2E-F333-43FB-9621-5CBBE7FDCDCB}", 8, 4],
  ["{18603FDC-E32A-4AB5-989C-0864C3EAD2B8}", 9, 2],
  ["{1E171933-4619-4E11-9A3F-F7608DF75F80}", 6, 4],
  ["{1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90}", 6, 3],
  ["{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}", 0, 2],
  ["{22838BEF-8BB2-4498-84A7-C5851F593DF1}", 1, 5],
  ["{284E427A-3D55-4303-BF80-6455036E1DE7}", 4, 2],
  ["{2A488322-F2BA-4B5B-9748-0D474271808F}", 10, 6],
  ["{2D5ABB26-0587-4C30-8999-92F81FD0307C}", 11, 0],
  ["{306799F8-075E-4A3A-A7F6-7FBC6576F1A4}", 9, 3],
  ["{327F97BB-C833-4FB7-BDE5-3F7075034690}", 9, 5],
  ["{35758FB7-9AC5-4552-8A53-C91805E547FA}", 4, 5],
  ["{37CE84F3-28C3-443E-9E96-99CF82512B78}", 7, 2],
  ["{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}", 5, 1],
  ["{3C2FFA5D-87B4-456A-9821-1D502468CF0F}", 4, 1],
  ["{46F890A9-2807-4EBB-B81D-B2AA78EC7F39}", 2, 5],
  ["{5202B0CA-FC54-4496-8BCA-5EF66A818D29}", 12, 0],
  ["{5940675A-B579-460E-94D1-54222C63F5DA}", 13, 0],
  ["{5A111915-BE36-4E01-A7E5-04B1672EAD32}", 8, 5],
  ["{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}", 0, 1],
  ["{5DA37D80-6434-44D0-A028-1B22A696006F}", 14, 2],
  ["{5FD0F851-EC5A-4D38-B0AD-8093EC10F338}", 5, 5],
  ["{616DA210-FB5B-4158-B5E0-FEB733F419BA}", 15, 0],
  ["{638B1855-1B75-4FBE-930C-398BA8C253C6}", 9, 6],
  ["{68D230F3-CF80-4859-8CE7-A43EE81993B5}", 5, 6],
  ["{69012ECD-51FC-41F1-AA8D-1B2483CD663E}", 8, 1],
  ["{69C7853C-536D-4A76-A0AE-DD22124D55A5}", 4, 3],
  ["{69CF1AB2-1976-4502-BF36-3FF5EA218861}", 1, 1],
  ["{6E25E649-3F16-4E02-A733-19D2CDBF48F0}", 10, 1],
  ["{72833802-FEF1-4C79-8D5D-14CF1EAF98D9}", 8, 2],
  ["{74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6}", 10, 5],
  ["{775DCB02-9BB8-47FD-8907-85C794F793BA}", 4, 4],
  ["{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}", 16, 0],
  ["{7DF18680-E054-41AD-8BC1-D1AEF772440D}", 0, 5],
  ["{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}", 17, 0],
  ["{85BE263C-DBD7-4A20-BB59-AAB30ACAA65A}", 10, 2],
  ["{8799B23B-EC83-4686-B30A-512413B5E67A}", 14, 3],
  ["{8A107856-5554-42FB-B03E-39F5DBC370BA}", 1, 2],
  ["{8EC20E35-A176-4012-BC5E-935CFFF8708E}", 18, 0],
  ["{8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B}", 7, 5],
  ["{912C8C85-51F0-491E-9774-3900AFEF0FD7}", 8, 6],
  ["{91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28}", 2, 3],
  ["{93296810-A885-4BE3-A3E7-6D5BEEA58F35}", 0, 6],
  ["{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}", 19, 0],
  ["{9DCAF9ED-07DC-4A11-8D7F-57B35C25682E}", 6, 2],
  ["{AF606853-7671-496A-8E4F-DF71F8EC918B}", 7, 6],
  ["{B301B821-A1FF-4177-AEE7-76D212191A09}", 6, 1],
  ["{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}", 14, 1],
  ["{BDBED569-4797-4DF1-A0F4-6AAB3CD982D8}", 14, 5],
  ["{C083E6E3-FA7D-4D7B-A595-EF9225AFEA82}", 5, 3],
  ["{C4B1156A-380E-4F78-BDF5-A606A8083BF9}", 1, 4],
  ["{D03447BB-5D67-496B-8E87-E561075AD55C}", 7, 3],
  ["{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}", 9, 1],
  ["{D27102A9-8310-4765-A935-A1911B00CA55}", 5, 4],
  ["{D7AC3CCA-C797-4891-BE02-D94E43425B78}", 20, 0],
  ["{E269D01E-BC32-4049-B463-5C60D7B0CCD2}", 9, 4],
  ["{E8034E78-7F5D-4C2E-B375-FC64B27BC917}", 21, 0],
  ["{E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3}", 14, 6],
  ["{E929F9F4-4A8F-4326-A1B4-22849713DDAB}", 7, 4],
  ["{EB344D84-9AFB-497E-A393-DC336BA19D2E}", 10, 3],
  ["{EB9631B5-78F2-41C9-869B-9F39066F8104}", 10, 4],
  ["{ED083AE6-46FA-4A59-8FB0-9F97EB10719F}", 14, 4],
  ["{F2DE63D5-997A-4646-A377-4702673A728D}", 8, 3],
  ["{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}", 0, 3],
  ["{FABFCF23-3B69-468F-B69F-88F6DE6A72F2}", 6, 5],
];
const styles = new Map(
  IDS.map(([id, template, accent]) => [id, { template, accent }]),
);
const parsed = new Map<string, Element>();
const NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PART_NAMES = [
  "wholeTbl",
  "firstRow",
  "firstCol",
  "lastRow",
  "lastCol",
  "band1H",
  "band1V",
  "band2H",
  "band2V",
];
function color(input: string | null, accent: number): string {
  if (!input) return "";
  const [scheme, ...transforms] = input.split("/");
  const name =
    scheme === "@"
      ? `accent${accent}`
      : scheme === "+"
        ? `accent${accent + 1}`
        : scheme;
  return `<a:schemeClr val="${name}">${transforms
    .map((transform) => {
      const [type, value] = transform.split(":");
      return `<a:${type} val="${value}"/>`;
    })
    .join("")}</a:schemeClr>`;
}
const fill = (input: string | null, accent: number) =>
  input ? `<a:solidFill>${color(input, accent)}</a:solidFill>` : "";
/** Package definitions take precedence at the caller. Only known GUIDs create
 * DOMs; the immutable, theme-relative cache is bounded to the 74 presets. */
export function presetTableStyle(id: string | undefined): Element | undefined {
  const key = id?.trim().toUpperCase(),
    entry = key && styles.get(key);
  if (!entry || !key) return undefined;
  const saved = parsed.get(key);
  if (saved) return saved;
  const [background, ...parts] = required(TEMPLATES[entry.template]);
  const xml = `<a:tblStyle xmlns:a="${NS}" styleId="${key}">${background ? `<a:tblBg><a:fill>${fill(background, entry.accent)}</a:fill></a:tblBg>` : ""}${parts
    .map((index, position) => {
      const [text, bold, paint, borders] = required(PARTS[index]);
      const textStyle =
        text || bold !== null || position === 0
          ? `<a:tcTxStyle${bold === null ? "" : ` b="${bold ? "on" : "off"}"`}>${position === 0 ? '<a:fontRef idx="minor"/>' : ""}${color(text, entry.accent)}</a:tcTxStyle>`
          : "";
      const lines = Object.entries(borders)
        .map(
          ([side, [paint, width]]) =>
            `<a:${side}><a:ln${width === null ? "" : ` w="${width}"`}>${fill(paint, entry.accent)}</a:ln></a:${side}>`,
        )
        .join("");
      return `<a:${PART_NAMES[position]}>${textStyle}<a:tcStyle>${paint ? `<a:fill>${fill(paint, entry.accent)}</a:fill>` : ""}${lines ? `<a:tcBdr>${lines}</a:tcBdr>` : ""}</a:tcStyle></a:${PART_NAMES[position]}>`;
    })
    .join("")}</a:tblStyle>`;
  const node = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement;
  parsed.set(key, node);
  return node;
}
