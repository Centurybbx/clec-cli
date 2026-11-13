from pathlib import Path
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor,as_completed
import xml.etree.ElementTree as E
import subprocess,json,time,threading,hashlib
root=Path('collection/web/cfnavi');urls=[]
for file in root.glob('post-sitemap*.xml'):
 urls.extend(x.find('{*}loc').text for x in E.parse(file).findall('.//{*}url') if x.find('{*}loc') is not None)
urls=sorted(set(u for u in urls if '/cat-clec/' in u)); gate=threading.Lock();stop=threading.Event();last=0.0
class Parser(HTMLParser):
 def __init__(self):super().__init__();self.active=False;self.skip=0;self.buf=[]
 def handle_starttag(self,t,a):
  if t=='main':self.active=True
  if self.active and t in ('script','style','nav','button','svg'):self.skip+=1
  if self.active and not self.skip and t in ('h1','h2','h3','p','div','li','br','section','article'):self.buf.append('\n')
 def handle_endtag(self,t):
  if self.active and self.skip and t in ('script','style','nav','button','svg'):self.skip-=1
  if t=='main':self.active=False
 def handle_data(self,d):
  if self.active and not self.skip and d.strip():self.buf.append(d.strip()+' ')
def fetch(u):
 global last
 ident=hashlib.sha256(u.encode()).hexdigest()[:16];html=root/'html'/(ident+'.html');txt=root/'text'/(ident+'.txt')
 if html.exists() and txt.exists():return {'url':u,'status':'existing','html':str(html),'text':str(txt)}
 if stop.is_set():return {'url':u,'status':'deferred_rate_limit'}
 with gate:
  time.sleep(max(0,1.0-(time.monotonic()-last)));last=time.monotonic()
 p=subprocess.run(['curl','-fsSL','--max-time','40','--retry','1','-A','CLEC-personal-archive/1.0',u],capture_output=True)
 if p.returncode:
  err=p.stderr.decode(errors='replace')[:300]
  if '429' in err:stop.set()
  return {'url':u,'status':'error','error':err}
 raw=p.stdout.decode('utf-8',errors='replace');parser=Parser();parser.feed(raw);text='\n'.join(x.strip() for x in ''.join(parser.buf).splitlines() if x.strip())
 if not text:return {'url':u,'status':'error','error':'main text not found'}
 html.parent.mkdir(parents=True,exist_ok=True);txt.parent.mkdir(parents=True,exist_ok=True);html.write_bytes(p.stdout);txt.write_text('来源: '+u+'\n\n'+text+'\n',encoding='utf-8');return {'url':u,'status':'ok','html':str(html),'text':str(txt),'characters':len(text)}
print('queued',len(urls),flush=True)
with ThreadPoolExecutor(max_workers=3) as pool,(root/'manifest.jsonl').open('a',encoding='utf-8') as out:
 for i,f in enumerate(as_completed([pool.submit(fetch,u) for u in urls]),1):
  x=f.result();out.write(json.dumps(x,ensure_ascii=False)+'\n');out.flush()
  if i%25==0:print('processed',i,'/',len(urls),flush=True)
