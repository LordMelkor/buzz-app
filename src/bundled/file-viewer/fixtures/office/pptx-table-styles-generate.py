# Extract the compact PARTS, TEMPLATES and IDS arrays in pptx-table-styles.ts.
# Python compatibility scaffold written for this extraction; derived data is MPL-2.0.
# Input source (pinned, not SpreadsheetML presetTableStyles.xml):
# https://raw.githubusercontent.com/LibreOffice/core/9d83595bbc85ee972633529086ed22382abdb8d2/oox/source/drawingml/table/predefined-table-styles.cxx
# python3 pptx-table-styles-generate.py SOURCE.cxx OUTPUT.json
from pathlib import Path
import re
import json
import subprocess
import sys
import tempfile
s=Path(sys.argv[1]).read_text()
s=re.sub(r'^#include.*\n','',s,flags=re.M)
s=re.sub(r'u"([^"\n]*)"(?:_ustr)?',r'"\1"',s)
s=s.replace('OUString','std::string').replace('.isEmpty()', '.empty()')
a=s.index('constexpr auto tokens');b=s.index('void setBorderLineType',a)
s=s[:a]+'''int resolveToken(const std::string& s) { return tokenMap.at(s); }\n\n'''+s[b:]
tokens=sorted(set(re.findall(r'XML_(\w+)',s)) | {f'accent{i}' for i in range(1,7)})
header='''#include <string>
#include <map>
#include <unordered_map>
#include <memory>
#include <optional>
#include <vector>
#include <iostream>
using sal_Int32 = int;
'''
header+='enum { '+','.join('XML_'+t for t in tokens)+' };\n'
header+='std::unordered_map<std::string,int> tokenMap={'+','.join('{"Accent'+str(i)+'",XML_accent'+str(i)+'}' for i in range(1,7))+'};\n'
header+='std::map<int,std::string> tokenNames={'+','.join('{XML_'+t+',"'+t+'"}' for t in tokens)+'};\n'
header+='''namespace oox { namespace drawingml {
struct Color { int scheme=-1; std::vector<std::pair<int,int>> transforms; void setSchemeClr(int c) {scheme=c;} void addTransformation(int t,int v) {transforms.emplace_back(t,v);} };
struct FillProperties { std::optional<int> moFillType; Color maFillColor; };
using FillPropertiesPtr=std::shared_ptr<FillProperties>;
struct LineProperties { std::optional<int> moLineWidth,moPresetDash; FillProperties maLineFill; };
using LinePropertiesPtr=std::shared_ptr<LineProperties>;
namespace table {
struct TableStylePart { std::optional<bool> bold; Color color; FillPropertiesPtr fill; std::map<int,LinePropertiesPtr> borders;
std::optional<bool>& getTextBoldStyle(){return bold;} Color& getTextColor(){return color;} FillPropertiesPtr& getFillProperties(){return fill;} auto& getLineBorders(){return borders;} };
struct TableStyle { std::string id,name; FillPropertiesPtr bg; std::string& getStyleId(){return id;} std::string& getStyleName(){return name;} FillPropertiesPtr& getBackgroundFillProperties(){return bg;}
'''
for part in ['WholeTbl','FirstRow','FirstCol','LastRow','LastCol','Band1H','Band1V','Band2H','Band2V']:
 header+=f'TableStylePart {part}; TableStylePart& get{part}(){{return {part};}}\n'
header+='}; } } }\n'
main='''
void printColor(const oox::drawingml::Color& c) { if(c.scheme<0){std::cout<<"null";return;} std::cout<<"\\\""<<tokenNames.at(c.scheme); for(auto [t,v]:c.transforms)std::cout<<"/"<<tokenNames.at(t)<<":"<<v;std::cout<<"\\\""; }
void printPart(const TableStylePart& p) {std::cout<<"[";printColor(p.color);std::cout<<",";if(p.bold)std::cout<<*p.bold;else std::cout<<"null";std::cout<<","; if(p.fill)printColor(p.fill->maFillColor);else std::cout<<"null"; std::cout<<",{";bool comma=false; for(auto [side,l]:p.borders){if(comma)std::cout<<",";comma=true;std::cout<<"\\\""<<tokenNames.at(side)<<"\\\":[";printColor(l->maLineFill.maFillColor);std::cout<<","<<l->moLineWidth.value_or(-1)<<"]";}std::cout<<"}]";}
int main(){ std::cout<<"{"; bool comma=false; for(auto [id,pair]:mStyleIdMap){if(comma)std::cout<<",";comma=true; auto s=CreateTableStyle(id);std::cout<<"\\\""<<id<<"\\\":{\\\"family\\\":\\\""<<pair.first<<"\\\",\\\"accent\\\":\\\""<<pair.second<<"\\\",\\\"bg\\\":";printColor(s->bg->maFillColor);std::cout<<",\\\"parts\\\":{";
'''
for i,part in enumerate(['WholeTbl','FirstRow','FirstCol','LastRow','LastCol','Band1H','Band1V','Band2H','Band2V']):
 main+=('std::cout<<",";' if i else '')+f'std::cout<<"\\\"{part[0].lower()+part[1:]}\\\":";printPart(s->{part});\n'
main+='std::cout<<"}}";}std::cout<<"}";}\n'
with tempfile.TemporaryDirectory() as scratch:
 source = Path(scratch) / "extract.cxx"
 binary = Path(scratch) / "extract"
 source.write_text(header+s+main)
 subprocess.run(["clang++", "-std=c++17", str(source), "-o", str(binary)], check=True)
 styles = json.loads(subprocess.check_output([str(binary)], text=True))
parts=[];templates=[];ids=[]
for guid,entry in sorted(styles.items()):
 accent=entry["accent"].lower()
 def normalize(v):
  if isinstance(v,str):
   if accent:v=v.replace(accent,"@")
   if entry["family"]=="Dark-Style-2" and accent:v=v.replace("accent"+str(int(accent[-1])+1),"+")
   return v
  if isinstance(v,list):return [normalize(x) for x in v]
  if isinstance(v,dict):return {k:normalize(x) for k,x in v.items()}
  return v
 template=[normalize(entry["bg"])]
 for p in entry["parts"].values():
  p=normalize(p)
  for border in p[3].values():
   if border[1] == -1:border[1] = None
  if p not in parts:parts.append(p)
  template.append(parts.index(p))
 if template not in templates:templates.append(template)
 ids.append([guid,templates.index(template),int(accent[-1]) if accent else 0])
Path(sys.argv[2]).write_text(json.dumps([parts,templates,ids],separators=(",",":")))
