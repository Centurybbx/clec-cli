from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET
import subprocess, json, re
root=Path.cwd(); out=root/'collection/text/local'; out.mkdir(parents=True,exist_ok=True)
files=list((root/'public-archivedwl-154').rglob('*'))+[root/'CLEC_James缘起与今日_简中.pdf']
records=[]
for p in files:
 if not p.is_file() or p.suffix.lower() not in ('.pdf','.pptx','.docx','.epub','.txt'): continue
 dest=out/(str(p.relative_to(root))+'.txt'); dest.parent.mkdir(parents=True,exist_ok=True)
 status='ok'
 try:
  ext=p.suffix.lower()
  if ext=='.pdf':
   q=subprocess.run(['pdftotext','-layout',str(p),str(dest)],capture_output=True,text=True)
   if q.returncode: raise RuntimeError(q.stderr[:300])
  elif ext=='.txt': dest.write_bytes(p.read_bytes())
  else:
   with ZipFile(p) as z:
    if ext=='.pptx':
     names=sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)),key=lambda n:int(re.search(r'\d+',n).group()))
    elif ext=='.docx': names=['word/document.xml']
    else: names=[n for n in z.namelist() if n.lower().endswith(('.xhtml','.html','.htm'))]
    parts=[]
    for n in names:
     try:
      tree=ET.fromstring(z.read(n)); lines=[]
      for e in tree.iter():
       if e.tag.rsplit('}',1)[-1] in ('p','h1','h2','h3','h4'):
        s=''.join(e.itertext()).strip()
        if s: lines.append(s)
      parts.append('--- '+n+' ---\n'+'\n'.join(lines))
     except ET.ParseError: parts.append('--- '+n+' ---\n[无法解析]')
    dest.write_text('\n\n'.join(parts),encoding='utf-8')
  if not dest.exists() or dest.stat().st_size==0: status='empty'
 except Exception as e: status='error: '+str(e)
 records.append({'source':str(p.relative_to(root)),'text':str(dest.relative_to(root)) if dest.exists() else None,'status':status})
(out/'manifest.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
print('files',len(records),'status', {s:sum(x['status']==s for x in records) for s in set(x['status'] for x in records)})
