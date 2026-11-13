from concurrent.futures import ThreadPoolExecutor,as_completed
from html.parser import HTMLParser
from pathlib import Path
import xml.etree.ElementTree as ET
import urllib.request, urllib.parse, json, time, threading, subprocess
root=Path('collection/web/clec168'); lock=threading.Lock(); gate=threading.Lock(); last=0.0
urls=[x.text for x in ET.parse(root/'sitemap.xml').findall('.//{*}loc')]
urls=[u for u in urls if urllib.parse.urlparse(u).path.split('/')[1:2] and urllib.parse.urlparse(u).path.split('/')[1] in ('blog','docs','database','video') and len(urllib.parse.urlparse(u).path.strip('/').split('/'))>=2 and '/page/' not in u and '/category/' not in u]
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
def fetch(url):
 global last
 path=urllib.parse.urlparse(url).path.strip('/')
 html=root/'html'/(path+'.html'); txt=root/'text'/(path+'.txt')
 if html.exists() and txt.exists(): return {'url':url,'status':'existing','html':str(html),'text':str(txt)}
 for attempt in range(3):
  try:
   with gate:
    time.sleep(max(0,0.35-(time.monotonic()-last))); last=time.monotonic()
   q=subprocess.run(['curl','-fsSL','--max-time','40','--retry','1','-A','CLEC-personal-archive/1.0',url],capture_output=True)
   if q.returncode: raise RuntimeError(q.stderr.decode(errors='replace')[:200])
   data=q.stdout
   page=data.decode('utf-8',errors='replace'); parser=Text(); parser.feed(page)
   text='\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())
   if not text: raise ValueError('no main text extracted')
   html.parent.mkdir(parents=True,exist_ok=True); txt.parent.mkdir(parents=True,exist_ok=True)
   html.write_bytes(data); txt.write_text('来源: '+url+'\n采集时间: '+time.strftime('%Y-%m-%d %H:%M:%S %z')+'\n\n'+text+'\n',encoding='utf-8')
   return {'url':url,'status':'ok','html':str(html),'text':str(txt),'characters':len(text)}
  except Exception as e:
   error=str(e); time.sleep(2**attempt)
 return {'url':url,'status':'error','error':error}
print('queued',len(urls),flush=True)
with ThreadPoolExecutor(max_workers=4) as pool, (root/'manifest.jsonl').open('a',encoding='utf-8') as log:
 futures=[pool.submit(fetch,u) for u in urls]
 for i,f in enumerate(as_completed(futures),1):
  item=f.result(); log.write(json.dumps(item,ensure_ascii=False)+'\n'); log.flush()
  if i%50==0: print('processed',i,'/',len(urls),flush=True)
