# Standalone copy of the Beacon QA deck generator, 2026-11-09.
# uv run --with python-pptx python src/bundled/file-viewer/fixtures/office/pptx-beacon-generate.py
from pathlib import Path
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches
from pptx.util import Pt as PPt

HERE = Path(__file__).parent


def deck():
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    navy = RGBColor(0x1F, 0x3A, 0x5F)

    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = "Beacon 2.0 launch review"
    s.placeholders[1].text = "Week one · Lighthouse Labs"
    s.notes_slide.notes_text_frame.text = "Thank the team; the numbers are on the next three slides."

    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Rollout went to plan"
    steps = ["Internal", "5%", "50%", "Everyone"]
    for i, label in enumerate(steps):
        box = s.shapes.add_shape(MSO_SHAPE.CHEVRON if i else MSO_SHAPE.PENTAGON, Inches(0.8 + i * 3.0), Inches(2.6), Inches(2.9), Inches(1.2))
        box.fill.solid()
        box.fill.fore_color.rgb = navy if i < 3 else RGBColor(0x2E, 0x8B, 0x57)
        box.line.fill.background()
        box.text_frame.text = label
        box.text_frame.paragraphs[0].runs[0].font.size = PPt(24)
        box.text_frame.paragraphs[0].runs[0].font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    note = s.shapes.add_textbox(Inches(0.8), Inches(4.4), Inches(11.5), Inches(1.5))
    note.text_frame.word_wrap = True
    note.text_frame.text = "Every gate passed on time. No rollback; one pause at 5% for a CDN timeout."
    note.text_frame.paragraphs[0].runs[0].font.size = PPt(22)
    s.notes_slide.notes_text_frame.text = "The pause lasted 20 minutes; see the Errors sheet."

    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Activation climbed all week"
    data = CategoryChartData()
    data.categories = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    data.add_series("Activation", (0.41, 0.43, 0.44, 0.47, 0.49, 0.50, 0.51))
    data.add_series("Day-1 retention", (0.62, 0.63, 0.65, 0.66, 0.68, 0.69, 0.70))
    chart = s.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS, Inches(0.8), Inches(1.7), Inches(11.7), Inches(5.3), data).chart
    chart.has_legend = True
    chart.legend.position = XL_LEGEND_POSITION.BOTTOM
    chart.legend.include_in_layout = False
    s.notes_slide.notes_text_frame.text = "Thursday is the 50% step; Friday is everyone."

    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Next steps"
    rows = [("Item", "Owner", "When"), ("Retire the 1.9 import path", "Ana", "Next sprint"), ("Illustration CDN fallback", "Sam", "Friday"), ("Week-two review", "Jo", "Next Thursday")]
    table = s.shapes.add_table(len(rows), 3, Inches(0.8), Inches(1.9), Inches(11.7), Inches(2.8)).table
    for r, row in enumerate(rows):
        for c, text in enumerate(row):
            table.cell(r, c).text = text
            table.cell(r, c).text_frame.paragraphs[0].runs[0].font.size = PPt(20)
    s.notes_slide.notes_text_frame.text = "Ask for owners before we close."
    prs.save(HERE / "pptx-beacon-launch-review.pptx")


deck()
