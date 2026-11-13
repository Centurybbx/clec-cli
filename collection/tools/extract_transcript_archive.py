from pathlib import Path
import zipfile,io,json,hashlib,re,collections
root=Path('collection/sources/drive'); archive=root/'transcripts.zip'; out=root/'archive-transcripts'; out.mkdir(parents=True,exist_ok=True); rows=[]; errors=[]
with zipfile.ZipFile(archive) as z:
 for n,outer in enumerate((x for x in z.infolist() if not x.is_dir()),1):
  rec={'archive_source':'https://drive.google.com/file/d/1r0J4HJ0UlXbDEH8ABGkOVB4MLSS7wFYr/view','outer_member':outer.filename,'id':f'{n:05d}','files':[]}
  try:
   data=z.read(outer); rec['nested_sha256']=hashlib.sha256(data).hexdigest()
   with zipfile.ZipFile(io.BytesIO(data)) as sub:
    for j,info in enumerate((x for x in sub.infolist() if not x.is_dir()),1):
     ext=Path(info.filename).suffix.lower()
     if ext not in ('.srt','.txt','.md','.vtt','.json','.str'): rec['files'].append({'original_name':info.filename,'status':'unsupported'}); continue
     b=sub.read(info); dest=out/(f'{n:05d}-{j:02d}'+ext); dest.write_bytes(b)
     rec['files'].append({'original_name':info.filename,'path':str(dest),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'status':'ok'})
   rec['status']='ok'
  except Exception as e: rec['status']='error'; rec['error']=str(e); errors.append(rec)
  rows.append(rec)
(root/'archive-transcripts-manifest.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows),encoding='utf-8')
print('nested archives',len(rows),'errors',len(errors),'files',sum(len(x['files']) for x in rows)); print('file types',dict(collections.Counter(Path(f.get('path','')).suffix for r in rows for f in r['files'] if f.get('path')))); print('first errors',errors[:2])
