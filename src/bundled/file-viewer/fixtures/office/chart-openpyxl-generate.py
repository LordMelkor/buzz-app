# Reproduces the fictional Beacon demo workbook's chart/cell content.
# uv run --with openpyxl chart-openpyxl-generate.py
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.styles import Font, PatternFill

HERE = Path(__file__).parent


def workbook():
    wb = Workbook()
    daily = wb.active
    daily.title = "Daily"
    head = Font(bold=True)
    fill = PatternFill("solid", fgColor="DCE6F2")
    daily.append(["Day", "Workspaces", "Activation", "Day-1 retention", "Errors per 1k"])
    rows = [
        ("Mon", 1200, 0.41, 0.62, 1.8),
        ("Tue", 1310, 0.43, 0.63, 1.6),
        ("Wed", 1405, 0.44, 0.65, 1.5),
        ("Thu", 2950, 0.47, 0.66, 1.9),
        ("Fri", 6120, 0.49, 0.68, 1.4),
        ("Sat", 6480, 0.50, 0.69, 1.2),
        ("Sun", 6710, 0.51, 0.70, 1.1),
    ]
    for row in rows:
        daily.append(row)
    for cell in daily[1]:
        cell.font = head
        cell.fill = fill
    for row in daily.iter_rows(min_row=2, min_col=3, max_col=4):
        for cell in row:
            cell.number_format = "0%"
    for row in daily.iter_rows(min_row=2, min_col=2, max_col=2):
        for cell in row:
            cell.number_format = "#,##0"
    for column, width in zip("ABCDE", [8, 13, 12, 16, 14]):
        daily.column_dimensions[column].width = width
    chart = LineChart()
    chart.title = "Activation and retention"
    chart.y_axis.number_format = "0%"
    chart.add_data(Reference(daily, min_col=3, max_col=4, min_row=1, max_row=8), titles_from_data=True)
    chart.set_categories(Reference(daily, min_col=1, min_row=2, max_row=8))
    chart.width, chart.height = 14, 7
    daily.add_chart(chart, "G2")

    regions = wb.create_sheet("Regions")
    regions.append(["Region", "Workspaces", "Activation"])
    for row in [("Americas", 3120, 0.52), ("Europe", 2210, 0.49), ("Asia Pacific", 1380, 0.47)]:
        regions.append(row)
    for cell in regions[1]:
        cell.font = head
        cell.fill = fill
    for row in regions.iter_rows(min_row=2, min_col=3, max_col=3):
        for cell in row:
            cell.number_format = "0%"
    regions.column_dimensions["A"].width = 14
    regions.column_dimensions["B"].width = 13
    bars = BarChart()
    bars.title = "Workspaces by region"
    bars.add_data(Reference(regions, min_col=2, min_row=1, max_row=4), titles_from_data=True)
    bars.set_categories(Reference(regions, min_col=1, min_row=2, max_row=4))
    bars.width, bars.height = 12, 7
    regions.add_chart(bars, "E2")

    errors = wb.create_sheet("Errors")
    errors.append(["Code", "Count", "Note"])
    for row in [("E401", 42, "Expired invite links"), ("E409", 17, "Duplicate import"), ("E503", 5, "CDN timeout")]:
        errors.append(row)
    for cell in errors[1]:
        cell.font = head
    errors.column_dimensions["C"].width = 22
    wb.save(HERE / "chart-openpyxl.xlsx")



workbook()
