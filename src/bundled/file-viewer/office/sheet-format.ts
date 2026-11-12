import { SSF, utils } from "@e965/xlsx";
import type { CellObject } from "@e965/xlsx";

/** Formatting is deferred until a view or chart admits this cell's work. */
export function sheetCellText(
  cell: CellObject | undefined,
  date1904: boolean | undefined,
  admit: (units: number) => void,
): string {
  if (!cell || cell.t === "z" || cell.v == null) return "";
  if (cell.w !== undefined) return cell.w;
  const format = typeof cell.z === "string" ? cell.z : "General";
  admit(format.length);
  try {
    cell.w =
      cell.t === "e"
        ? utils.format_cell(cell)
        : (SSF.format(format, cell.v, { date1904 }) as string);
  } catch {
    cell.w = String(cell.v);
  }
  return cell.w;
}
