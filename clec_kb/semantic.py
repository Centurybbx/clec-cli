"""Local semantic retrieval. Derived vectors are rebuilt when the source index changes."""
from __future__ import annotations

import json
import hashlib
import os
import sqlite3
import sys
from pathlib import Path

MODEL = 'collection/models/bge-small-zh-v1.5'
WINDOW = 200
STEP = 175
BATCH = 64
INSTRUCTION = '为这个句子生成表示以用于检索相关文章：'


def model_fingerprint(root):
    h = hashlib.sha256()
    for name in ('config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'vocab.txt'):
        h.update(name.encode())
        with (root/MODEL/name).open('rb') as stream:
            while data := stream.read(1024*1024):
                h.update(data)
    return h.hexdigest()


def require_dependencies():
    try:
        import numpy as np
        import torch
        from transformers import AutoModel, AutoTokenizer
        return np, torch, AutoModel, AutoTokenizer
    except ImportError as exc:
        raise ValueError('语义检索缺少本地 AI 依赖，请阅读 README 的本地 AI 安装说明') from exc


def load_encoder(root):
    np, torch, AutoModel, AutoTokenizer = require_dependencies()
    path = root/MODEL
    if not path.exists():
        raise ValueError('本地语义模型不存在：' + str(path))
    tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True)
    model = AutoModel.from_pretrained(str(path), local_files_only=True)
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    model = model.to(device).eval()
    return np, torch, model, tokenizer, device


def encode(np, torch, model, tokenizer, device, texts):
    inputs = tokenizer(texts, padding=True, truncation=True, max_length=256, return_tensors='pt').to(device)
    with torch.inference_mode():
        data = model(**inputs).last_hidden_state[:, 0]
        data = torch.nn.functional.normalize(data, p=2, dim=1)
    return data.cpu().numpy().astype(np.float16)


def windows(text):
    for start in range(0, len(text), STEP):
        end = min(start+WINDOW, len(text))
        if text[start:end].strip():
            yield start, end
        if end == len(text):
            break


def build_semantic(root, dbpath, output, batch_size=BATCH):
    np, torch, model, tokenizer, device = load_encoder(root)
    fingerprint = model_fingerprint(root)
    with sqlite3.connect(dbpath) as db:
        revision = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0]
        rows = db.execute('SELECT id, text FROM chunk ORDER BY id').fetchall()
    # Chunk ids include source content hash. The revision guards all derived files.
    docs = []
    for ident, text in rows:
        for start, end in windows(text):
            docs.append((ident.encode('ascii'), start, end, text[start:end]))
    count = len(docs)
    output.mkdir(parents=True, exist_ok=True)
    statefile = output/'partial.json'
    matrixfile = output/'vectors.partial.npy'
    metafile = output/'segments.partial.npy'
    dtype = np.dtype([('id', 'S24'), ('start', '<i4'), ('end', '<i4')])
    start_batch = 0
    if statefile.exists() and matrixfile.exists() and metafile.exists():
        state = json.loads(statefile.read_text())
        if state == {'revision': revision, 'count': count, 'window': WINDOW, 'step': STEP,
                     'model_fingerprint': fingerprint, 'processed': state.get('processed')}:
            start_batch = state['processed']
    if start_batch:
        vectors = np.lib.format.open_memmap(matrixfile, mode='r+')
        segments = np.lib.format.open_memmap(metafile, mode='r+')
        if vectors.shape != (count, 512) or segments.shape != (count,):
            raise ValueError('未完成索引的尺寸不匹配，请删除 index/semantic 中 partial 文件并重试')
    else:
        vectors = np.lib.format.open_memmap(matrixfile, mode='w+', dtype=np.float16, shape=(count, 512))
        segments = np.lib.format.open_memmap(metafile, mode='w+', dtype=dtype, shape=(count,))
    for i in range(start_batch, count, batch_size):
        group = docs[i:i+batch_size]
        vectors[i:i+len(group)] = encode(np, torch, model, tokenizer, device, [x[3] for x in group])
        segments[i:i+len(group)] = [(x[0], x[1], x[2]) for x in group]
        if (i//batch_size) % 100 == 0 or i+len(group) == count:
            vectors.flush(); segments.flush()
            statefile.write_text(json.dumps({'revision': revision, 'count': count, 'window': WINDOW, 'step': STEP,
                                             'model_fingerprint': fingerprint,
                                             'processed': i+len(group)}))
            print(f'语义索引 {i+len(group)}/{count}', file=sys.stderr, flush=True)
    del vectors, segments
    os.replace(matrixfile, output/'vectors.npy')
    os.replace(metafile, output/'segments.npy')
    statefile.unlink(missing_ok=True)
    result = {'revision': revision, 'count': count, 'model': MODEL, 'model_fingerprint': fingerprint,
              'window': WINDOW, 'step': STEP}
    (output/'metadata.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def search_semantic(root, db, output, query, limit=20, after=None, before=None, source_type=None):
    if not query.strip():
        raise ValueError('请输入非空查询词')
    metadata_path = output/'metadata.json'
    if not metadata_path.exists():
        raise ValueError('语义索引尚未完成，请先运行 semantic-build')
    meta = json.loads(metadata_path.read_text())
    revision = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0]
    if meta['revision'] != revision:
        raise ValueError('语义索引与资料索引版本不一致，请重新运行 semantic-build')
    if meta.get('model_fingerprint') != model_fingerprint(root):
        raise ValueError('语义模型文件已改变，请重新运行 semantic-build')
    np, torch, model, tokenizer, device = load_encoder(root)
    vec = encode(np, torch, model, tokenizer, device, [INSTRUCTION+query])[0].astype(np.float32)
    vectors = np.load(output/'vectors.npy', mmap_mode='r')
    segments = np.load(output/'segments.npy', mmap_mode='r')
    # Dot product in blocks avoids making a float32 copy of the whole matrix.
    scores = np.empty(len(vectors), dtype=np.float32)
    for i in range(0, len(vectors), 16384):
        scores[i:i+16384] = vectors[i:i+16384].astype(np.float32) @ vec
    # Examine every ranked window until enough distinct eligible sources are found.
    order = np.argsort(-scores)
    seen, out = set(), []
    for index in order:
        item = segments[index]
        ident = item['id'].decode('ascii')
        row = db.execute('''SELECT c.id,c.text,c.locator,s.id source_id,s.title,s.type,s.quality,
                                   s.date,s.date_basis,s.path,s.url,s.sha256
                            FROM chunk c JOIN source s ON s.id=c.source_id WHERE c.id=?''', (ident,)).fetchone()
        if row is None or row['source_id'] in seen:
            continue
        if after and (not row['date'] or row['date'] < after): continue
        if before and (not row['date'] or row['date'] > before): continue
        if source_type and row['type'] != source_type: continue
        seen.add(row['source_id'])
        record = dict(row)
        record['evidence_id'] = record.pop('id')
        record['locator'] = json.loads(record['locator'])
        record['matched_window'] = record['text'][int(item['start']):int(item['end'])]
        record['semantic_score'] = round(float(scores[index]), 4)
        out.append(record)
        if len(out) == limit: break
    unknown = None
    if after or before:
        sql = "SELECT count(*) FROM source WHERE status='ok' AND date IS NULL"
        params = ()
        if source_type:
            sql += ' AND type=?'
            params = (source_type,)
        unknown = db.execute(sql, params).fetchone()[0]
    return {'query': query, 'results': out, 'index_revision': revision,
            'unknown_date_sources_excluded': unknown,
            'note': '语义相似度只表示检索相关性，不表示事实正确或证据支持结论；必须展开原文核验。日期筛选时排除数量为整个索引中日期未知的来源数。'}
