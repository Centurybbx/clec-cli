"""Audit semantic-window coverage and numerical integrity for the real index."""
import json
import sqlite3
import sys
from pathlib import Path
import numpy as np

root=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root))
from clec_kb.semantic import model_fingerprint, windows
folder=root/'index/semantic'
meta=json.loads((folder/'metadata.json').read_text())
seg=np.load(folder/'segments.npy',mmap_mode='r')
vec=np.load(folder/'vectors.npy',mmap_mode='r')
assert meta['model_fingerprint']==model_fingerprint(root)
assert len(seg)==len(vec)==meta['count']
assert vec.shape[1]==512
pos=chunks=0
with sqlite3.connect(root/'index/clec.sqlite3') as db:
    rev=db.execute("select value from meta where key='revision'").fetchone()[0]
    assert meta['revision']==rev
    for ident,text in db.execute('select id,text from chunk order by id'):
        chunks+=1
        for start,end in windows(text):
            x=seg[pos]
            assert x['id'].decode()==ident and int(x['start'])==start and int(x['end'])==end, (ident,start,end,pos)
            pos+=1
assert pos==len(seg)
for i in range(0,len(vec),8192):
    data=vec[i:i+8192].astype(np.float32)
    norm=np.linalg.norm(data,axis=1)
    assert np.isfinite(data).all() and np.all((norm>0.98)&(norm<1.02)), i
print(json.dumps({'index_revision':rev,'chunks_checked':chunks,'windows_checked':pos,
                  'window_coverage':'matches all indexed chunks','vectors':'finite, normalized'},ensure_ascii=False,indent=2))
