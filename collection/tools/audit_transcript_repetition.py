from pathlib import Path
from collections import Counter
import re,json
rows=[]
for f in Path('collection/web/clectw/transcripts').glob('*.txt'):
 s=f.read_text(encoding='utf-8'); parts=[x.strip() for x in re.split(r'[，。！？,!?；;\n]+',s) if len(x.strip())>=4]; counts=Counter(parts); word,n=counts.most_common(1)[0] if counts else ('',0); share=n/len(parts) if parts else 0; rows.append({'file':str(f),'characters':len(s),'sentence_count':len(parts),'most_repeated_sentence':word[:120],'repeat_count':n,'repeat_share':round(share,4),'status':'suspected_repetition_needs_review' if n>=8 and share>.2 else 'not_flagged_automatically'})
Path('collection/web/clectw/transcript-quality-audit.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in rows),encoding='utf-8'); bad=[x for x in rows if x['status'].startswith('suspected')];print('files',len(rows),'flagged',len(bad));print('\n'.join(x['file']+' '+str(x['repeat_share'])+' '+x['most_repeated_sentence'][:50] for x in bad[:12]))
