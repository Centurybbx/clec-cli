"""Download and verify the pinned BGE embedding model from its ModelScope mirror."""
import hashlib
import os
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'collection/models/bge-small-zh-v1.5'
BASE='https://www.modelscope.cn/models/AI-ModelScope/bge-small-zh-v1.5/resolve/master/'
FILES={
'config.json':'3853a7979202c348751b753e36f579c41d8da7d36af617d3d907e1fc9b441f2a',
'model.safetensors':'354763b9b1357bc9c44f62c6be2276321081ed2567773608c0d0785b61d5a026',
'special_tokens_map.json':'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
'tokenizer.json':'48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
'tokenizer_config.json':'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
'vocab.txt':'45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
}


def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while block:=f.read(1024*1024):h.update(block)
    return h.hexdigest()


def main():
    DEST.mkdir(parents=True,exist_ok=True)
    for name,expected in FILES.items():
        p=DEST/name
        if p.exists() and sha(p)==expected:
            print('verified',name,flush=True);continue
        part=p.with_suffix(p.suffix+'.part')
        print('downloading',name,flush=True)
        try:
            with urllib.request.urlopen(BASE+name,timeout=60) as response, part.open('wb') as out:
                while block:=response.read(1024*1024):out.write(block)
            if sha(part)!=expected: raise ValueError('模型文件 SHA-256 不匹配：'+name)
            os.replace(part,p)
        finally:
            part.unlink(missing_ok=True)
    print('model ready',DEST)


if __name__=='__main__':main()
