from odf.opendocument import OpenDocumentPresentation, OpenDocumentChart
from odf.element import Element
from odf.namespaces import OFFICENS, STYLENS, TEXTNS, TABLENS, DRAWNS, PRESENTATIONNS, SVGNS, FONS, XLINKNS, CHARTNS
from pathlib import Path
import base64, tempfile

# Reproduce with: uv run --with odfpy==1.4.1 python odp-generate.py
png_dir=tempfile.TemporaryDirectory(prefix="mdv-odp-")
png=Path(png_dir.name)/"pixel.png"
png.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII="))
NS=dict(office=OFFICENS,style=STYLENS,text=TEXTNS,table=TABLENS,draw=DRAWNS,presentation=PRESENTATIONNS,svg=SVGNS,fo=FONS,xlink=XLINKNS,chart=CHARTNS)
def E(tag,attrs=None,*children):
 prefix,name=tag.split(':');e=Element(qname=(NS[prefix],name),check_grammar=False)
 for k,v in (attrs or {}).items():
  p,n=k.split(':');e.setAttrNS(NS[p],n,str(v))
 for c in children:
  if isinstance(c,str):e.addText(c,check_grammar=False)
  else:e.addElement(c,check_grammar=False)
 return e
def add(where,what):where.addElement(what,check_grammar=False);return what
def P(text,style=None):return E('text:p',{'text:style-name':style} if style else {},text)
doc=OpenDocumentPresentation()
layout=E('style:page-layout',{'style:name':'Wide'},E('style:page-layout-properties',{'fo:page-width':'10in','fo:page-height':'7.5in'}));add(doc.automaticstyles,layout)
master=E('style:master-page',{'style:name':'Master','style:page-layout-name':'Wide'});add(doc.masterstyles,master)
add(doc.styles,E('style:style',{'style:name':'Body','style:family':'paragraph'},E('style:paragraph-properties',{'fo:margin-top':'3pt','fo:margin-bottom':'6pt','fo:line-height':'125%'}),E('style:text-properties',{'fo:font-size':'18pt','fo:color':'#112233','fo:font-family':'DejaVu Sans'})))
add(doc.styles,E('style:style',{'style:name':'Emphasis','style:family':'text'},E('style:text-properties',{'fo:font-weight':'bold','fo:font-style':'italic','style:text-underline-style':'solid','fo:color':'#cc0000'})))
add(doc.styles,E('style:style',{'style:name':'CardBase','style:family':'graphic'},E('style:graphic-properties',{'draw:fill':'solid','draw:fill-color':'#ddeeff','draw:stroke':'solid','svg:stroke-color':'#223344','svg:stroke-width':'0.5pt','fo:padding':'0.1cm','draw:textarea-vertical-align':'middle'})))
add(doc.automaticstyles,E('style:style',{'style:name':'Card','style:family':'graphic','style:parent-style-name':'CardBase'},E('style:graphic-properties',{'draw:fill-color':'#aaccee'})))
add(doc.automaticstyles,E('style:style',{'style:name':'Hidden','style:family':'drawing-page'},E('style:drawing-page-properties',{'presentation:visibility':'hidden'})))
add(doc.styles,E('text:list-style',{'style:name':'Bullets'},E('text:list-level-style-bullet',{'text:level':'1','text:bullet-char':'•'},E('style:list-level-properties',{'text:space-before':'0.2cm','text:min-label-width':'0.3cm'}))))
add(doc.automaticstyles,E('style:style',{'style:name':'Column','style:family':'table-column'},E('style:table-column-properties',{'style:column-width':'1in'})))
add(doc.automaticstyles,E('style:style',{'style:name':'Row','style:family':'table-row'},E('style:table-row-properties',{'style:row-height':'0.4in'})))
add(doc.automaticstyles,E('style:style',{'style:name':'Cell','style:family':'table-cell'},E('style:table-cell-properties',{'fo:background-color':'#ffeecc','fo:border':'1pt solid #333333','style:vertical-align':'middle'})))
def frame(name,x,y,w,h,*children,klass=None,style='Card'):
 attrs={'draw:name':name,'draw:style-name':style,'svg:x':x,'svg:y':y,'svg:width':w,'svg:height':h}
 if klass:attrs['presentation:class']=klass
 return E('draw:frame',attrs,*children)
page=E('draw:page',{'draw:name':'Third physical name','draw:master-page-name':'Master'});add(doc.presentation,page)
add(page,frame('Title','1in','0.25in','8in','0.75in',E('draw:text-box',{},P('ODP native deck','Body')),klass='title'))
para=E('text:p',{'text:style-name':'Body'},'Hello ',E('text:span',{'text:style-name':'Emphasis'},'styled'),E('text:a',{'xlink:href':'https://example.org/odp'},' docs'),E('text:line-break'), 'second line')
bullets=E('text:list',{'text:style-name':'Bullets'},E('text:list-item',{},P('First bullet','Body'),P('Continuation','Body')),E('text:list-item',{},P('Second bullet','Body')))
add(page,frame('Body','1in','1.5in','4in','2in',E('draw:text-box',{},para,bullets)))
geom=E('draw:enhanced-geometry',{'draw:type':'non-primitive','svg:viewBox':'0 0 21600 21600','draw:modifiers':'5400','draw:enhanced-path':'M ?inset 0 L 21600 10800 ?inset 21600 0 10800 Z'},E('draw:equation',{'draw:name':'inset','draw:formula':'$0'}))
add(page,E('draw:custom-shape',{'draw:name':'Adjusted','draw:style-name':'Card','svg:x':'6in','svg:y':'1.5in','svg:width':'2in','svg:height':'1in'},geom,P('Diamond-like','Body')))
add(page,E('draw:custom-shape',{'draw:name':'Preset arrow','draw:style-name':'Card','svg:x':'6in','svg:y':'3in','svg:width':'2in','svg:height':'1in'},E('draw:enhanced-geometry',{'draw:type':'right-arrow','svg:viewBox':'0 0 21600 21600','draw:modifiers':'5400'})))
add(page,E('draw:line',{'draw:style-name':'Card','svg:x1':'0in','svg:y1':'0in','svg:x2':'1in','svg:y2':'1in','draw:transform':'scale(2 2)'}))
group=E('draw:g',{'draw:name':'Group','draw:transform':'translate(2cm 3cm)'},E('draw:rect',{'draw:style-name':'Card','svg:x':'0cm','svg:y':'0cm','svg:width':'1cm','svg:height':'1cm'}),E('draw:ellipse',{'draw:style-name':'Card','svg:x':'2cm','svg:y':'0cm','svg:width':'1cm','svg:height':'1cm'}));add(page,group)
picture=doc.addPicture(str(png))
add(page,frame('Embedded pixel','1in','4in','1in','1in',E('draw:image',{'xlink:href':picture,'xlink:type':'simple'}),E('svg:title',{},'Embedded image')))
add(page,frame('Remote','2in','4in','1in','1in',E('draw:image',{'xlink:href':'https://example.org/remote.png','xlink:type':'simple'})))
table=E('table:table',{'table:name':'Small table'},E('table:table-column',{'table:style-name':'Column','table:number-columns-repeated':'2'}),E('table:table-row',{'table:style-name':'Row'},E('table:table-cell',{'table:style-name':'Cell','table:number-columns-spanned':'2'},P('Merged heading')),E('table:covered-table-cell')),E('table:table-row',{'table:style-name':'Row'},E('table:table-cell',{'table:style-name':'Cell'},P('North')),E('table:table-cell',{},P('42'))))
add(page,frame('Table','4in','4in','2in','0.8in',table))
chart=OpenDocumentChart();add(chart.body,E('office:chart',{},E('chart:chart',{'chart:class':'chart:bar'},E('chart:title',{},P('Cached ODF chart')))));href=doc.addObject(chart)
add(page,frame('Chart','6in','5in','2in','1in',E('draw:object',{'xlink:href':href,'xlink:type':'simple'})))
add(page,E('presentation:notes',{},frame('Notes','0in','0in','5in','3in',E('draw:text-box',{},P('Speaker notes: retain me.')),klass='notes')))
add(doc.presentation,E('draw:page',{'draw:name':'Hidden','draw:master-page-name':'Master','draw:style-name':'Hidden'},frame('Hidden title','0in','0in','1in','1in',E('draw:text-box',{},P('Do not show')),klass='title')))
add(doc.presentation,E('draw:page',{'draw:name':'First physical name','draw:master-page-name':'Master'},frame('Last title','0in','0in','5in','1in',E('draw:text-box',{},P('Final visible slide')),klass='title')))
output=Path(__file__).with_name('odp-odfpy.odp')
doc.save(str(output))
png_dir.cleanup()
print('saved odfpy',output.stat().st_size)
