from pathlib import Path
from difflib import SequenceMatcher
import json,re
p=Path('collection/sources/podcast'); podcasts=[json.loads(x) for x in (p/'episode-inventory.jsonl').read_text().splitlines()]; episodes=[json.loads(x) for x in Path('collection/web/clectw/episode-inventory.jsonl').read_text().splitlines()]
def norm(s):
 s=re.sub(r'(CLEC|James|投資理財頻道|投資理財教育學院|漫談|Podcast|短篇|長篇)', '',s,flags=re.I); return re.sub(r'[^\w\u4e00-\u9fff]','',s).lower()
for e in episodes:e['_norm']=norm(e.get('title') or '')
out=[]
for r in podcasts:
 if r['status']!='no_id_match_needs_review':continue
 title=norm(r['title']); candidates=[]
 if len(title)>=6:
  for e in episodes:
   v=e['_norm']; score=SequenceMatcher(None,title,v,autojunk=False).ratio()
   if score>=.34:candidates.append((score,e))
  candidates.sort(key=lambda a:a[0],reverse=True)
 out.append({'feed':r['feed'],'title':r['title'],'guid':r['guid'],'candidates':[{'score':round(s,3),'episode_id':e['episode_id'],'title':e.get('title'),'url':e['url'],'transcript':e.get('transcript')} for s,e in candidates[:3]],'status':'candidate_needs_verification'})
(p/'unmatched-title-candidates.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in out),encoding='utf-8'); print('unmatched',len(out),'with candidates',sum(bool(x['candidates']) for x in out))
