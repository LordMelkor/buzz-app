export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 200;

export type Table = Readonly<{
  rows: readonly (readonly string[])[];
  /** Rows and columns past the limits, which the viewer leaves out. */
  omittedRows: number;
  omittedColumns: number;
}>;

/** RFC 4180 rows: quoted fields may hold the delimiter, quotes and newlines. */
export function parseTable(text: string, delimiter: "," | "\t"): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let omittedRows = 0;
  let widest = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    widest = Math.max(widest, row.length);
    if (rows.length < MAX_ROWS) rows.push(row.slice(0, MAX_COLUMNS));
    else omittedRows++;
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      endRow();
    } else field += char;
  }
  if (field !== "" || row.length > 0) endRow();
  return {
    rows,
    omittedRows,
    omittedColumns: Math.max(0, widest - MAX_COLUMNS),
  };
}
