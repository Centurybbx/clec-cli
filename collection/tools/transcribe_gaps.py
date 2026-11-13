from pathlib import Path
import json,subprocess,os,re,hashlib,time,collections
root=Path.cwd(); model=root/'collection/models/whisper-small-mlx-4bit'; out=root/'collection/transcripts/local-asr'; out.mkdir(parents=True,exist_ok=True)
env=os.environ.copy(); env['PATH']=str(root/'collection/.transcribe-venv/bin')+os.pathsep+env.get('PATH','')
rows=json.load(open(root/'collection/web/clec168/cross-source-assessments.json')); todo=[{'id':'short-'+x['source_episode_id'],'source':x['source_url'],'media_url':'https://cdn.clec168.com/video/short/'+x['source_episode_id']+'.mp4'} for x in rows if x['assessment']=='unresolved']
todo.extend([
 {'id':'ep-00176','source':'https://clectw.com/ep/ep-00176','media_url':'https://drive.google.com/file/d/1n9dAdGk9PmCnKoIkwJB7sJLmo3soq6ci/view','expected_size':20420171},
 {'id':'ep-00260','source':'https://clectw.com/ep/ep-00260','media_url':'https://drive.google.com/file/d/1Jnq-PYz6cPwgPYK0_KsEvx0ZAJuFJGhs/view','expected_size':60469814},
 {'id':'ep-00295','source':'https://clectw.com/ep/ep-00295','media_url':'https://drive.google.com/file/d/16oh0SbBR3zMx5rWfyUPbiJlQjQQLvNoI/view','expected_size':259228579},
])
def seconds(x): return sum(float(y.replace(',','.'))*60**i for i,y in enumerate(reversed(x.split(':'))))
for item in todo:
 ident=item['id']; media=root/'collection/tmp'/(ident+'.mp4'); folder=out/ident;folder.mkdir(exist_ok=True); meta=folder/'metadata.json'
 if meta.exists():print(ident,'already processed',flush=True);continue
 if (root/'collection/transcripts/quarantine'/ident/'metadata.json').exists():print(ident,'quarantined; manual review required',flush=True);continue
 if not media.exists() or (item.get('expected_size') and media.stat().st_size!=item['expected_size']):print(ident,'media unavailable or incomplete',flush=True);continue
 digest=hashlib.sha256(media.read_bytes()).hexdigest(); info=subprocess.run(['ffmpeg','-hide_banner','-i',str(media)],env=env,capture_output=True,text=True); m=re.search(r'Duration: (\d+:\d+:\d+\.\d+)',info.stderr); duration=seconds(m.group(1)) if m else None
 start=time.monotonic(); p=subprocess.run([str(root/'collection/.transcribe-venv/bin/mlx_whisper'),str(media),'--model',str(model),'--language','zh','--output-format','all','--output-dir',str(folder),'--verbose','False'],env=env,capture_output=True,text=True)
 (folder/'transcription.log').write_text(p.stderr[-12000:]+p.stdout[-12000:],encoding='utf-8'); txt=folder/(ident+'.txt');srt=folder/(ident+'.srt');j=folder/(ident+'.json'); valid=False;reason=''; end=None
 if p.returncode==0 and all(x.is_file() and x.stat().st_size>0 for x in (txt,srt,j)):
  try:
   data=json.loads(j.read_text()); text=txt.read_text().strip(); timestamps=re.findall(r'-->\s*(\d+:\d+:\d+[,\.]\d+)',srt.read_text());end=seconds(timestamps[-1]) if timestamps else 0
   valid=bool(text and timestamps and data.get('segments'))
  except Exception as e:reason=str(e)
 else:reason='process failed or output missing'
 ratio=round(end/duration,4) if end and duration else None
 lines=[x.strip() for x in txt.read_text().splitlines() if x.strip()] if valid else []
 repeated=(max(collections.Counter(lines).values())/len(lines)) if lines else 0
 if valid and (repeated>.25 or (ratio is not None and ratio>1.05)):
  valid=False; reason='suspected hallucination: repeated line or timestamp beyond source duration'
 rec={**item,'model':'mlx-community/whisper-small-mlx-4bit','language':'zh','media_sha256':digest,'duration_seconds':duration,'subtitle_last_end_seconds':end,'ratio':ratio,'elapsed_seconds':round(time.monotonic()-start,1),'status':'machine_unverified' if valid else 'failed','note':'自动转写尚未校对，金融术语、数字和讲话人均需复核。','temporary_media_deleted':False,'reason':reason}
 if valid and ratio is not None and .8<=ratio<=1.05: media.unlink();rec['temporary_media_deleted']=True
 meta.write_text(json.dumps(rec,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(ident,rec['status'],'coverage',ratio,'temp_deleted',rec['temporary_media_deleted'],flush=True)
