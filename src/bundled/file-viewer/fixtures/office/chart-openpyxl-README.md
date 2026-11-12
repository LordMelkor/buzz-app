# Openpyxl chart workbook

`chart-openpyxl.xlsx` is the fictional Beacon launch demo workbook, copied from
`beacon-launch-metrics.xlsx` during the Office reader QA on 2026-11-09. It has
saved worksheet values and three sheets; the Daily line chart and Regions
column chart refer to those cells without `numCache` or `strCache` elements.
This reproduces empty charts from otherwise readable openpyxl workbooks.

`chart-openpyxl-generate.py` reproduces its cell/chart content with openpyxl.
ZIP timestamps and producer metadata can vary between runs. Run it beside the
fixture with `uv run --with openpyxl chart-openpyxl-generate.py`.
