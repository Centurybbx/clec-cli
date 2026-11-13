from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
import json,subprocess
rows=json.load(open('collection/sources/podcast/no-automatic-candidate.json'));root=Path('collection/tmp');root.mkdir(exist_ok=True)
def run(pair):
 i,row=pair;dest=root/('podcast-gap-'+str(i)+'.m4a');url=row['enclosure_url'];p=subprocess.run(['curl','-fLsS','--connect-timeout','20','--max-time','900','--retry','1','-C','-',url,'-o',str(dest)],capture_output=True,text=True);r={'id':i,'source':row['feed'],'title':row['title'],'guid':row['guid'],'media_url':url,'path':str(dest),'status':'ok' if p.returncode==0 and dest.exists() and dest.stat().st_size>0 else 'error','bytes':dest.stat().st_size if dest.exists() else 0,'error':p.stderr[-200:] if p.returncode else ''};print('podcast',i,r['status'],flush=True);return r
with ThreadPoolExecutor(max_workers=2) as ex:out=list(ex.map(run,enumerate(rows,1)))
(root/'podcast-gap-downloads.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
