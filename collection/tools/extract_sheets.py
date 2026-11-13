from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET
import json,re
root=Path.cwd(); out=root/'collection/text/local'; records=[]
for p in (root/'public-archivedwl-154').rglob('*.xlsx'):
 dest=out/(str(p.relative_to(root))+'.txt'); dest.parent.mkdir(parents=True,exist_ok=True)
 try:
  with ZipFile(p) as z:
   shared=[]
   if 'xl/sharedStrings.xml' in z.namelist():
    shared=[''.join(e.itertext()) for e in ET.fromstring(z.read('xl/sharedStrings.xml')) if e.tag.endswith('}si')]
   sheets=sorted((n for n in z.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml',n)),key=lambda n:int(re.search(r'\d+',n).group()))
   lines=[]
   for sheet in sheets:
    lines.append('--- '+sheet+' ---')
    for row in ET.fromstring(z.read(sheet)).iter():
     if not row.tag.endswith('}row'): continue
     cells=[]
     for cell in row:
      if not cell.tag.endswith('}c'): continue
      vals={c.tag.rsplit('}',1)[-1]:''.join(c.itertext()) for c in cell}
      v=vals.get('v',vals.get('is',''))
      if cell.get('t')=='s' and v: v=shared[int(v)]
      f=vals.get('f')
      if v or f: cells.append(cell.get('r','')+': '+v+(' [公式: '+f+']' if f else ''))
     if cells: lines.append('\t'.join(cells))
   dest.write_text('\n'.join(lines)+'\n',encoding='utf-8')
  records.append({'source':str(p.relative_to(root)),'text':str(dest.relative_to(root)),'status':'ok'})
 except Exception as e: records.append({'source':str(p.relative_to(root)),'status':'error','error':str(e)})
(out/'spreadsheets-manifest.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8'); print('spreadsheets',len(records),'ok',sum(x['status']=='ok' for x in records))
