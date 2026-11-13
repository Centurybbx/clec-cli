from pathlib import Path
from opencc import OpenCC
from collections import Counter
import json,re
cc=OpenCC('t2s'); root=Path('collection/transcripts/local-asr'); qs=[]
def grams(s):
 s=re.sub(r'[^\w\u4e00-\u9fff]','',cc.convert(s)).lower();return {s[i:i+3] for i in range(max(0,len(s)-2))}
for p in sorted(root.glob('short-*/metadata.json')):
 d=json.loads(p.read_text()); text=(p.parent/(d['id']+'.txt')).read_text();qs.append((d['id'],grams(text[:5000])))
results={id:[] for id,_ in qs}; sources=[]
for p in Path('collection/web/clectw/transcripts').glob('*.txt'):sources.append((str(p),'website',None))
for row in map(json.loads,open('collection/sources/drive/archive-transcripts-manifest.jsonl')):
 for f in row['files']:
  if f.get('path','').endswith('.txt'):sources.append((f['path'],'archive',row['outer_member']))
for path,typ,name in sources:
 try: text=Path(path).read_text(encoding='utf-8')[:6000]; g=grams(text)
 except (UnicodeError,OSError):continue
 for ident,q in qs:
  denom=min(len(q),len(g));score=len(q&g)/denom if denom else 0
  if score>=.25: results[ident].append({'path':path,'source_type':typ,'source_name':name,'shared_trigram_fraction':round(score,4)})
for id in results:results[id]=sorted(results[id],key=lambda x:x['shared_trigram_fraction'],reverse=True)[:8]
Path('collection/transcripts/local-asr-candidates.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n');
for k,v in results.items():print(k,[(x['path'].split('/')[-1],x['shared_trigram_fraction']) for x in v[:3]])
