from pathlib import Path
from collections import Counter
import json,re,unicodedata
base=Path('collection/sources/drive'); items=[json.loads(x) for x in (base/'archive-transcripts-manifest.jsonl').read_text().splitlines()]; clectw={x['episode_id'].lower():x for x in map(json.loads,Path('collection/web/clectw/episode-inventory.jsonl').read_text().splitlines())}; rows=[]
def secs(x):
 parts=[float(v.replace(',','.')) for v in x.split(':')]; return sum(v*60**i for i,v in enumerate(reversed(parts)))
for item in items:
 parts=item['outer_member'].split('/'); name=parts[-1];cat=parts[1] if len(parts)>1 else ''; normalized=unicodedata.normalize('NFKC',name); match=re.match(r'(\d{5})(?:([a-zA-Z])|\s+([a-zA-Z])(?=\s|短篇|[【〖（]))?',normalized); match=None if re.match(r'\d{5}\s+\d',normalized) else match;prefix='short-' if cat=='短篇' else 'ep-' if cat.startswith('長篇') else None; ident=(prefix+match.group(1)+(match.group(2) or match.group(3) or '').lower()) if prefix and match else None
 files=item['files']; sub=next((x for x in files if x.get('path','').endswith(('.srt','.str'))),None); record={'archive_id':item['id'],'outer_member':item['outer_member'],'candidate_episode_id':ident,'status':'no_exact_id_or_duration'}
 if ident and ident in clectw and sub:
  text=Path('collection/web/clectw/text/ep',ident+'.txt').read_text(); m=re.search(r'·\s*([\d:]+)\s*收藏',text); st=Path(sub['path']).read_text(errors='replace'); times=re.findall(r'-->\s*(\d+:\d+:\d+[,\.]\d+)',st)
  if m and times:
   duration=secs(m.group(1)); end=secs(times[-1]); ratio=end/duration if duration else 0; record.update(status='duration_checked_id_match_unverified',video_duration_seconds=duration,subtitle_last_end_seconds=end,ratio=round(ratio,4),source_url=clectw[ident]['url'],subtitle=sub['path'])
 rows.append(record)
counts=Counter(x.get('candidate_episode_id') for x in rows if x.get('candidate_episode_id'))
for x in rows:
 if x.get('candidate_episode_id') and counts[x['candidate_episode_id']]>1: x['duplicate_id_warning']=True
(base/'archive-timing-audit.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in rows),encoding='utf-8'); checked=[x for x in rows if x['status'].startswith('duration_checked')];print('archive',len(rows),'checked',len(checked),'subtitle end < 90% of video',sum(x['ratio']<.9 for x in checked),'end >110%',sum(x['ratio']>1.1 for x in checked))
