from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
import subprocess,json
rows=json.load(open('collection/web/clec168/cross-source-assessments.json')); todo=[x for x in rows if x['assessment']=='unresolved']; d=Path('collection/tmp');d.mkdir(exist_ok=True)
def run(x):
 name=x['source_episode_id']; dest=d/('short-'+name+'.mp4'); url='https://cdn.clec168.com/video/short/'+name+'.mp4'
 for attempt in range(3):
  args=['curl','-fLsS','--connect-timeout','20','--max-time','240','-C','-',url,'-o',str(dest)]; p=subprocess.run(args,capture_output=True,text=True)
  if p.returncode==0 and dest.exists() and dest.stat().st_size>1000: return {'id':name,'url':url,'path':str(dest),'status':'ok','bytes':dest.stat().st_size}
 return {'id':name,'url':url,'status':'error','error':p.stderr[-300:]}
results=[]
with ThreadPoolExecutor(max_workers=2) as ex:
 for f in as_completed([ex.submit(run,x) for x in todo]):
  x=f.result();results.append(x);print(x['id'],x['status'],flush=True)
Path('collection/tmp/unmatched-downloads.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
