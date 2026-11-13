from pathlib import Path
from html import unescape
import re,json,hashlib,datetime,os
base=Path('collection/web/clectw'); html_dir=base/'html/ep'; out=base/'transcripts'; out.mkdir(parents=True,exist_ok=True)
urls=(base/'discovered-episode-urls.txt').read_text(encoding='utf-8').splitlines()
last={}
for line in (base/'manifest.jsonl').read_text(encoding='utf-8').splitlines():
 try:
  row=json.loads(line); last[row['url']]=row
 except json.JSONDecodeError: continue
rows=[]
for url in urls:
 slug=url.rsplit('/',1)[-1]; path=html_dir/(slug+'.html'); record={'url':url,'episode_id':slug,'status':'not_yet_downloaded','transcript_status':'unknown'}
 if path.exists():
  raw=path.read_bytes(); html=raw.decode('utf-8',errors='replace'); title=re.search(r'<title[^>]*>(.*?)</title>',html,re.S|re.I)
  record.update(status='downloaded',html=str(path),html_sha256=hashlib.sha256(raw).hexdigest(),title=unescape(re.sub(r'<[^>]+>','',title.group(1))).strip() if title else None)
  m=re.search(r'<p class="text-ink leading-loose whitespace-pre-line"[^>]*>(.*?)</p>',html,re.S)
  notice='逐字稿由影片語音自動轉錄' in html
  if m and notice:
   body=unescape(m.group(1)).strip(); dest=out/(slug+'.txt'); dest.write_text(body+'\n',encoding='utf-8')
   record.update(transcript_status='automatic_unverified',transcript=str(dest),characters=len(body),timestamps='not_verified')
  else: record.update(transcript_status='not_found_on_downloaded_page')
 elif url in last and last[url].get('status')=='error': record.update(status='download_failed',error=last[url].get('error'))
 rows.append(record)
tmp=base/'episode-inventory.jsonl.tmp'; dest=base/'episode-inventory.jsonl'
tmp.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows),encoding='utf-8'); os.replace(tmp,dest)
from collections import Counter
print('indexed',len(rows),'page statuses',dict(Counter(r['status'] for r in rows)),'transcript statuses',dict(Counter(r['transcript_status'] for r in rows)))
