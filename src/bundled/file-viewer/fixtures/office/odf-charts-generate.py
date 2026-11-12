"""Generate synthetic ODF chart packages with odfpy 1.4.1.
uv run --with odfpy==1.4.1 python src/bundled/file-viewer/fixtures/office/odf-charts-generate.py
"""
from pathlib import Path
from odf.opendocument import OpenDocumentPresentation, OpenDocumentSpreadsheet, OpenDocumentChart
from odf.element import Element
from odf.namespaces import OFFICENS, STYLENS, TEXTNS, TABLENS, DRAWNS, SVGNS, FONS, XLINKNS, CHARTNS
NS = dict(office=OFFICENS, style=STYLENS, text=TEXTNS, table=TABLENS, draw=DRAWNS, svg=SVGNS, fo=FONS, xlink=XLINKNS, chart=CHARTNS)
def E(tag, attrs=None, *children):
    prefix, name = tag.split(':')
    node = Element(qname=(NS[prefix], name), check_grammar=False)
    for key, value in (attrs or {}).items():
        prefix, name = key.split(':'); node.setAttrNS(NS[prefix], name, str(value))
    for child in children:
        if isinstance(child, str): node.addText(child, check_grammar=False)
        else: node.addElement(child, check_grammar=False)
    return node
def add(parent, child): parent.addElement(child, check_grammar=False); return child
def cell(value):
    attrs = {'office:value-type': 'float', 'office:value': value} if isinstance(value, (float, int)) else {'office:value-type': 'string'}
    return E('table:table-cell', attrs, E('text:p', {}, str(value)))
def table(name, values):
    return E('table:table', {'table:name': name}, *[E('table:table-row', {}, *[cell(v) for v in row]) for row in values])
for extension in ['ods', 'odp']:
    doc = OpenDocumentSpreadsheet() if extension == 'ods' else OpenDocumentPresentation()
    parent = table('Sales Q1', [['Quarter', 'Revenue'], ['Q1', 12.5], ['Q2', 21], ['Q3', 0]])
    if extension == 'odp':
        add(doc.automaticstyles, E('style:page-layout', {'style:name': 'Wide'}, E('style:page-layout-properties', {'fo:page-width': '10in', 'fo:page-height': '7.5in'})))
        add(doc.masterstyles, E('style:master-page', {'style:name': 'Master', 'style:page-layout-name': 'Wide'}))
        page = add(doc.presentation, E('draw:page', {'draw:name': 'Chart', 'draw:master-page-name': 'Master'}))
        add(page, E('draw:frame', {'svg:width': '2in', 'svg:height': '2in'}, parent))
        container = page
    else:
        add(doc.spreadsheet, parent); container = add(parent, E('table:shapes'))
    chart = OpenDocumentChart()
    add(chart.automaticstyles, E('style:style', {'style:name': 'Plot', 'style:family': 'chart'}, E('style:chart-properties', {'chart:vertical': 'false'})))
    add(chart.automaticstyles, E('style:style', {'style:name': 'Blue', 'style:family': 'chart'}, E('style:graphic-properties', {'draw:fill-color': '#123456'})))
    plot = E('chart:plot-area', {'chart:style-name': 'Plot'}, E('chart:axis', {'chart:dimension': 'x'}, E('chart:categories', {'table:cell-range-address': 'local-table.A2:.A4'})), E('chart:series', {'chart:class': 'chart:bar', 'chart:style-name': 'Blue', 'chart:values-cell-range-address': 'local-table.B2:.B4', 'chart:label-cell-address': 'local-table.B1'}))
    add(chart.body, E('office:chart', {}, E('chart:chart', {'chart:class': 'chart:bar'}, E('chart:title', {}, E('text:p', {}, 'Saved revenue')), plot, table('local-table', [['Cached quarter', 'Cached revenue'], ['Cache1', 91], ['Cache2', 92], ['Cache3', 93]]))))
    href = doc.addObject(chart)
    add(container, E('draw:frame', {'svg:x': '2in', 'svg:y': '2in', 'svg:width': '5in', 'svg:height': '3in'}, E('draw:object', {'xlink:href': href, 'xlink:type': 'simple'})))
    output = Path(__file__).with_name('charts-odfpy.' + extension); doc.save(str(output)); print(output)
