# Spreadsheet and foundation fixtures

Created 2026-11-09 for Office compatibility tests. All cell/document content is synthetic and authored for these tests.

- `foundation.docx`: python-docx 1.2.0; heading and one paragraph.
- `sheets-real.xlsx`: XlsxWriter 3.3.1; visible sheet, hidden row/column, merged cells, cached formulas/number formats, an embedded chart, a chart sheet, hidden and very-hidden sheets.
- `sheets-real.ods`: odfpy 1.4.1; two string cells.
- `sheets-real.xls`, `sheets-real.xlsb`: SheetJS 0.20.3 producer; two rows of synthetic strings, a number and a boolean. These test adapter/container compatibility; the separately produced XLSX/ODS and native Numbers fixtures provide independent producer evidence.
- `sheets-real.numbers`: native Numbers 14.5, generated on 2026-11-09. Budget has Item/Cost, Rent 1200, Food 450.5 and Total formula cached as 1650.5; Notes has one cell. Re-zipped stored without `Data/` theme images; other parts unchanged.

Hostile archive/formula/cap variants are constructed in tests.
