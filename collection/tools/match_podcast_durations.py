from pathlib import Path
from xml.etree import ElementTree as E
from difflib import SequenceMatcher
import json,re,collections
inv=[json.loads(x) for x in Path('collection/web/clectw/episode-inventory.jsonl').read_text().splitlines()]; eps=[]
def sec(s):
 try:return sum(float(x)*60**i for i,x in enumerate(reversed(s.split(':'))))
 except:return None
def norm(s):return re.sub(r'[^\w\u4e00-\u9fff]','',s).lower().replace('臺','台')
for e in inv:
 p=Path('collection/web/clectw/text/ep')/(e['episode_id']+'.txt')
 if not p.exists():continue
 m=re.search(r'·\s*([\d:]+)\s*收藏',p.read_text()); d=sec(m.group(1)) if m else None
 if d:eps.append((d,e,norm(e.get('title') or '')))
rows=[]
for f in Path('collection/sources/podcast').glob('*.xml'):
 for i in E.parse(f).findall('.//item'):
  title=i.findtext('title') or ''; duration=next((e.text for e in i if e.tag.endswith('}duration')),None); d=sec(duration) if duration else None; t=norm(title); candidates=[]
  if d:
   for ed,e,et in eps:
    delta=abs(d-ed)
    if delta>max(4,d*.02):continue
    score=SequenceMatcher(None,t,et).ratio()
    if score>=.22:candidates.append((score,delta,e))
  candidates.sort(key=lambda x:(-x[0],x[1]));rows.append({'feed':f.name,'title':title,'guid':i.findtext('guid'),'duration_seconds':d,'candidates':[{'episode_id':e['episode_id'],'title':e.get('title'),'url':e['url'],'transcript':e.get('transcript'),'duration_delta_seconds':delta,'title_similarity':round(score,3)} for score,delta,e in candidates[:3]],'status':'candidate_needs_verification'})
Path('collection/sources/podcast/duration-candidates.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in rows),encoding='utf-8');print('items',len(rows),'with candidate',sum(bool(x['candidates']) for x in rows),'without candidate',sum(not x['candidates'] for x in rows))
