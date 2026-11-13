"""Verbatim navigation extracts; these are not a substitute for reading a source."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path


def select_excerpt(text, target=220):
    """Choose a contiguous excerpt near the middle without inventing any wording."""
    if len(text) <= target:
        return 0, len(text), text
    start = max(0, (len(text)-target)//2)
    # Start and end at nearby line/sentence boundaries when possible.
    for sep in ('\n', '。', '！', '？'):
        p = text.find(sep, start, min(len(text), start+45))
        if p >= 0:
            start = p+1
            break
    end = min(len(text), start+target)
    for sep in ('\n', '。', '！', '？'):
        p = text.rfind(sep, max(start+target//2, 0), end)
        if p >= 0:
            end = p+1
            break
    return start, end, text[start:end]


def build_digests(dbpath: Path, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.digests-', suffix='.jsonl', dir=dest.parent)
    count = docs = 0
    try:
        with sqlite3.connect(dbpath) as db, os.fdopen(fd, 'w', encoding='utf-8') as out:
            db.row_factory = sqlite3.Row
            rev = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0]
            rows = db.execute('''SELECT s.id,s.title,s.date,s.date_basis,s.type,s.quality,s.path,s.url,s.sha256,
                                        c.id evidence_id,c.ordinal,c.text,c.locator
                                 FROM source s JOIN chunk c ON c.source_id=s.id ORDER BY s.id,c.ordinal''')
            current = None
            doc = None
            for row in rows:
                if current != row['id']:
                    if doc is not None:
                        out.write(json.dumps(doc,ensure_ascii=False)+'\n'); docs += 1
                    current = row['id']
                    doc = {k: row[k] for k in ('id','title','date','date_basis','type','quality','path','url','sha256')}
                    doc.update({'index_revision':rev,'method':'verbatim_navigation_extracts',
                                'warning':'每片段仅摘录部分原文；不代表全部内容，也未确认说话人或事实。','extracts':[]})
                start,end,excerpt = select_excerpt(row['text'])
                doc['extracts'].append({'evidence_id':row['evidence_id'],'ordinal':row['ordinal'],
                                        'start_in_chunk':start,'end_in_chunk':end,'text':excerpt,
                                        'locator':json.loads(row['locator'])})
                count += 1
            if doc is not None:
                out.write(json.dumps(doc,ensure_ascii=False)+'\n'); docs += 1
        os.replace(temp,dest)
        return {'index_revision':rev,'sources':docs,'chunks_covered':count,'path':str(dest),
                'method':'verbatim_navigation_extracts'}
    except BaseException:
        try: os.unlink(temp)
        except FileNotFoundError: pass
        raise


def get_digest(db, dest, ident, offset=0, limit=10):
    if not dest.exists():
        raise ValueError('摘录索引不存在，请先运行 digest-build')
    revision = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0]
    with dest.open(encoding='utf-8') as stream:
        for line in stream:
            doc = json.loads(line)
            if doc['id'] != ident:
                continue
            if doc['index_revision'] != revision:
                raise ValueError('摘录索引与资料索引版本不一致，请重新运行 digest-build')
            all_extracts = doc['extracts']
            doc['extract_count'] = len(all_extracts)
            doc['extracts'] = all_extracts[offset:offset+limit]
            doc['next_offset'] = offset+limit if offset+limit < len(all_extracts) else None
            return doc
    raise ValueError('找不到可检索的资料：' + ident)
