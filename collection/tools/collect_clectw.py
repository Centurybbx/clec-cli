from concurrent.futures import ThreadPoolExecutor,as_completed
from html.parser import HTMLParser
from pathlib import Path
import subprocess,re,time,json,threading
root=Path('collection/web/clectw'); root.mkdir(parents=True,exist_ok=True); gate=threading.Lock(); last=0; stop=threading.Event()
class Text(HTMLParser):
 def __init__(self): super().__init__(); self.main=False; self.skip=0; self.parts=[]
 def handle_starttag(self,t,a):
  if t=='main': self.main=True
  if self.main and t in ('script','style','nav','button','svg'): self.skip+=1
  if self.main and not self.skip and t in ('p','div','section','article','h1','h2','h3','h4','li','br','tr'): self.parts.append('\n')
 def handle_endtag(self,t):
  if self.main and self.skip and t in ('script','style','nav','button','svg'): self.skip-=1
  if t=='main': self.main=False
 def handle_data(self,d):
  if self.main and not self.skip and d.strip(): self.parts.append(d.strip()+' ')
def get(url,kind,name):
 global last
 if stop.is_set(): return {'url':url,'status':'deferred_rate_limit'}
 html=root/'html'/kind/(name+'.html'); txt=root/'text'/kind/(name+'.txt')
 if html.exists() and txt.exists(): return {'url':url,'status':'existing','html':str(html),'text':str(txt)}
 html.parent.mkdir(parents=True,exist_ok=True); txt.parent.mkdir(parents=True,exist_ok=True)
 with gate:
  time.sleep(max(0,2.0-(time.monotonic()-last))); last=time.monotonic()
 q=subprocess.run(['curl','-fsSL','--max-time','40','--retry','1','-A','CLEC-personal-archive/1.0',url],capture_output=True)
 if q.returncode:
  error=q.stderr.decode(errors='replace')[:300]
  if '429' in error: stop.set()
  return {'url':url,'status':'error','error':error}
 page=q.stdout.decode('utf-8',errors='replace'); p=Text(); p.feed(page); text='\n'.join(s.strip() for s in ''.join(p.parts).splitlines() if s.strip())
 if not text: return {'url':url,'status':'error','error':'main text missing'}
 html.write_bytes(q.stdout); txt.write_text('来源: '+url+'\n采集时间: '+time.strftime('%Y-%m-%d %H:%M:%S %z')+'\n\n'+text+'\n',encoding='utf-8')
 return {'url':url,'status':'ok','html':str(html),'text':str(txt),'characters':len(text),'mentions_transcript':'逐字稿由影片語音自動轉錄' in text}
def run(items,label):
 with ThreadPoolExecutor(max_workers=4) as pool, (root/'manifest.jsonl').open('a',encoding='utf-8') as log:
  futures=[pool.submit(get,*x) for x in items]
  for i,f in enumerate(as_completed(futures),1):
   item=f.result(); log.write(json.dumps(item,ensure_ascii=False)+'\n'); log.flush()
   if i%25==0: print(label,i,'/',len(items),flush=True)
run([('https://clectw.com/videos?page='+str(n),'listing',str(n)) for n in range(1,91)],'listing')
if stop.is_set(): raise SystemExit('Rate limit encountered; stop and retry later.')
links=set()
for f in (root/'html/listing').glob('*.html'):
 links.update(re.findall(r'https://clectw\.com/ep/[\w-]+',f.read_text(encoding='utf-8')))
print('episode URLs',len(links),flush=True)
run([(u,'ep',u.rsplit('/',1)[-1]) for u in sorted(links)],'episode')
