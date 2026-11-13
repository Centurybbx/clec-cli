from pathlib import Path
from xml.etree import ElementTree as ET
import json,re,collections
base=Path('collection/sources/podcast'); inv=[json.loads(x) for x in Path('collection/web/clectw/episode-inventory.jsonl').read_text().splitlines()]; lookup={x['episode_id'].lower():x for x in inv}; rows=[]
for f in base.glob('*.xml'):
 for i in ET.parse(f).findall('.//item'):
  title=i.findtext('title') or ''; enc=i.find('enclosure'); enurl=enc.get('url') if enc is not None else None; m=re.search(r'(?<!\d)(\d{5})(?!\d)',title); talk=re.search(r'\bEP[.：:\s]*(\d{1,4})\b',title,re.I); guesses=[]
  if talk: guesses.append('talk-'+talk.group(1).zfill(5))
  if not m:
   four=re.match(r'\s*[【\[]?(0\d{3})(?!\d)',title)
   if four: guesses.extend(['ep-'+four.group(1).zfill(5),'short-'+four.group(1).zfill(5)])
  if m: guesses.extend(['ep-'+m.group(1),'short-'+m.group(1)])
  matches=[{'episode_id':g,'url':lookup[g]['url'],'transcript':lookup[g].get('transcript'),'transcript_status':lookup[g]['transcript_status']} for g in guesses if g in lookup]
  rows.append({'feed':f.name,'title':title,'published':i.findtext('pubDate'),'guid':i.findtext('guid'),'enclosure_url':enurl,'identifier_candidates':guesses,'possible_matches':matches,'status':'id_match_needs_review' if matches else 'no_id_match_needs_review'})
out=base/'episode-inventory.jsonl'; out.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows),encoding='utf-8'); print('podcast episodes',len(rows),'status',dict(collections.Counter(r['status'] for r in rows)))
