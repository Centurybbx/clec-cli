from __future__ import annotations

import bisect
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
from pathlib import Path

from opencc import OpenCC

CONVERTER = OpenCC('t2s')
SCHEMA_VERSION = 1
SOURCE_TYPES = ('transcript', 'subtitle', 'article', 'summary', 'document', 'spreadsheet', 'ocr')


def normalize(text: str) -> str:
    return CONVERTER.convert(unicodedata.normalize('NFKC', text)).casefold()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_date(title: str):
    m = re.search(r'(?<!\d)(20\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?', title)
    if not m:
        return None
    try:
        return dt.date(*map(int, m.groups())).isoformat()
    except ValueError:
        return None


def jsonlines(path: Path):
    if not path.exists():
        return
    with path.open(encoding='utf-8') as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def read_text(path: Path):
    return path.read_bytes().decode('utf-8-sig')


def srt_cues(text: str):
    lines = text.splitlines()
    cues = []
    time_pat = re.compile(r'^\s*(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})')
    i = 0
    while i < len(lines):
        m = time_pat.match(lines[i])
        if not m:
            i += 1
            continue
        time_line = i
        cue_number = lines[i-1].strip() if i and lines[i-1].strip().isdigit() else None
        start_line = i + 1
        i += 1
        content = []
        while i < len(lines) and lines[i].strip():
            content.append(lines[i])
            i += 1
        if content:
            cues.append({'text': '\n'.join(content), 'start': m.group(1), 'end': m.group(2),
                         'cue': cue_number, 'line_start': start_line + 1, 'line_end': i,
                         'time_line': time_line + 1})
        i += 1
    return cues


def pieces(text: str, size=900):
    """Split text without altering it; offsets are Python Unicode character offsets."""
    if not text.strip():
        return
    starts = [0] + [m.end() for m in re.finditer('\n', text)]
    pos = 0
    while pos < len(text):
        end = min(len(text), pos + size)
        if end < len(text):
            floor = pos + size // 2
            breaks = [text.rfind(ch, floor, end) for ch in ('\n', '。', '！', '？', '.', '!', '?')]
            b = max(breaks)
            if b >= floor:
                end = b + 1
        segment = text[pos:end]
        if segment.strip():
            yield segment, {'kind': 'text', 'char_start': pos, 'char_end': end,
                            'line_start': bisect.bisect_right(starts, pos),
                            'line_end': bisect.bisect_right(starts, max(pos, end-1))}
        pos = end


def subtitle_pieces(cues, size=900):
    group = []
    length = 0
    for cue in cues:
        if group and length + len(cue['text']) > size:
            yield _subtitle_group(group)
            group, length = [], 0
        group.append(cue)
        length += len(cue['text'])
    if group:
        yield _subtitle_group(group)


def _subtitle_group(group):
    return '\n'.join(c['text'] for c in group), {'kind': 'subtitle', 'start': group[0]['start'],
        'end': group[-1]['end'], 'cue_start': group[0]['cue'], 'cue_end': group[-1]['cue'],
        'line_start': group[0]['time_line'], 'line_end': group[-1]['line_end'],
        'timestamp_scope': 'source_subtitle_only'}


def create_schema(db):
    db.executescript('''
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE source (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, quality TEXT NOT NULL,
      url TEXT, path TEXT, original_path TEXT, sha256 TEXT, date TEXT, date_basis TEXT,
      status TEXT NOT NULL, family TEXT, duplicate_of TEXT, details TEXT NOT NULL,
      search_meta TEXT NOT NULL
    );
    CREATE TABLE chunk (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source(id), ordinal INTEGER NOT NULL,
      text TEXT NOT NULL, search_text TEXT NOT NULL, locator TEXT NOT NULL, fingerprint TEXT NOT NULL
    );
    CREATE INDEX chunk_source_ordinal ON chunk(source_id, ordinal);
    CREATE INDEX source_date ON source(date);
    CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id UNINDEXED, search_text, tokenize='trigram');
    ''')


class Builder:
    def __init__(self, root: Path, db):
        self.root, self.db = root, db
        self.count = 0

    def add(self, ident, title, typ, quality, path=None, url=None, original_path=None,
            family=None, duplicate_of=None, details=None, status=None, date=None, date_basis=None):
        pathobj = self.root / path if path else None
        sha = None
        text = None
        if pathobj is not None:
            try:
                data = pathobj.read_bytes()
                sha = digest(data)
                text = data.decode('utf-8-sig')
                status = status or ('empty' if not text.strip() else 'ok')
            except FileNotFoundError:
                status = 'missing'
            except UnicodeDecodeError:
                status = 'decode_error'
        else:
            status = status or 'unavailable'
        if date is None:
            date = source_date(title)
            date_basis = 'title' if date else None
        if duplicate_of and status == 'ok':
            status = 'duplicate_representation'
        meta = normalize(title + ' ' + ident)
        self.db.execute('INSERT INTO source VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (ident, title, typ, quality, url, path, original_path, sha, date,
                         date_basis, status, family, duplicate_of, json.dumps(details or {}, ensure_ascii=False), meta))
        if status != 'ok' or text is None:
            return
        if typ == 'subtitle':
            cue_list = srt_cues(text)
            if not cue_list:
                self.db.execute("UPDATE source SET status='no_subtitle_text' WHERE id=?", (ident,))
                return
            iterator = subtitle_pieces(cue_list)
        else:
            iterator = pieces(text)
        for ordinal, (chunk, loc) in enumerate(iterator):
            chunk_id = digest(f'{ident}\0{sha}\0{ordinal}'.encode())[:24]
            search = normalize(chunk)
            fp = digest(re.sub(r'\s+', '', chunk).encode())
            self.db.execute('INSERT INTO chunk VALUES (?,?,?,?,?,?,?)',
                            (chunk_id, ident, ordinal, chunk, search, json.dumps(loc, ensure_ascii=False), fp))
            self.db.execute('INSERT INTO chunk_fts VALUES (?,?)', (chunk_id, meta + '\n' + search))
            self.count += 1


def archive_sources(builder: Builder, coll: Path):
    for row in jsonlines(coll/'sources/drive/archive-transcripts-manifest.jsonl'):
        family = 'archive:' + row['id']
        title = row['outer_member'].split('/')[-1]
        files = row['files']
        subtitle = next((f for f in files if f.get('path', '').endswith(('.srt', '.str'))), None)
        plain = next((f for f in files if f.get('path', '').endswith('.txt')), None)
        markdown = next((f for f in files if f.get('path', '').endswith('.md')), None)
        subtitle_text = plain_text = None
        try:
            if subtitle:
                subtitle_text = ''.join(c['text'] for c in srt_cues(read_text(builder.root/subtitle['path'])))
            if plain:
                plain_text = read_text(builder.root/plain['path'])
        except (FileNotFoundError, UnicodeDecodeError):
            pass
        canon = family + ':subtitle'
        same = bool(subtitle_text and plain_text and re.sub(r'\s+', '', subtitle_text) == re.sub(r'\s+', '', plain_text))
        md_same = False
        if same and markdown:
            try:
                m = read_text(builder.root/markdown['path'])
                md_body = '\n'.join(line for line in m.splitlines() if not line.lstrip().startswith('#'))
                md_same = bool(md_body.strip()) and re.sub(r'\s+', '', md_body) == re.sub(r'\s+', '', plain_text)
            except (FileNotFoundError, UnicodeDecodeError):
                pass
        for f in files:
            p = f.get('path')
            if not p:
                continue
            ext = Path(p).suffix.lower()
            part = 'subtitle' if ext in ('.srt', '.str') else 'text' if ext == '.txt' else 'markdown'
            typ = 'subtitle' if part == 'subtitle' else 'transcript'
            duplicate = canon if (part == 'text' and same) or (part == 'markdown' and md_same) else None
            header_only = False
            if part == 'markdown':
                try:
                    header_only = not '\n'.join(z for z in read_text(builder.root/p).splitlines() if not z.lstrip().startswith('#')).strip()
                except (FileNotFoundError, UnicodeDecodeError):
                    pass
            builder.add(family+':'+part, title, typ, 'machine_unverified', path=p,
                        url=row.get('archive_source'), family=family, duplicate_of=duplicate,
                        status='heading_only' if header_only else None,
                        details={'archive_member': row['outer_member'], 'member_name': f.get('original_name'),
                                 'expected_sha256': f.get('sha256'), 'relationship': 'same_content' if duplicate else None})


def collect_sources(builder: Builder):
    root, coll = builder.root, builder.root/'collection'
    archive_sources(builder, coll)
    for x in jsonlines(coll/'web/clectw/episode-inventory.jsonl'):
        builder.add('clectw:'+x['episode_id'], x.get('title') or x['episode_id'], 'transcript',
                    x.get('transcript_status', 'unknown'), path=x.get('transcript'), url=x.get('url'),
                    status=None if x.get('transcript') else 'unavailable',
                    details={'episode_id': x['episode_id'], 'html_path': x.get('html'),
                             'timing': x.get('timestamps', 'not_verified'), 'speaker': 'unknown'})
    for name in ('clec168', 'cfnavi'):
        seen = {}
        for x in jsonlines(coll/f'web/{name}/manifest.jsonl'):
            if x.get('status') in ('ok', 'existing') and x.get('text'):
                seen[x['url']] = x
        for url, x in seen.items():
            typ = 'summary' if (name == 'cfnavi' or '/video/' in url) else 'article'
            p = x['text']
            try:
                lines = read_text(root/p).splitlines()
                title = next((line.strip() for line in lines[3:] if line.strip()), url)
            except (FileNotFoundError, UnicodeDecodeError):
                title = url
            builder.add(name+':'+digest(url.encode())[:20], title[:500], typ, 'derived_unverified',
                        path=p, url=url, details={'html_path': x.get('html'), 'speaker': 'unknown'})
    for filename in ('text-manifest.json', 'nested-text-manifest.json', 'deep-text-manifest.json'):
        p = coll/'sources/drive'/filename
        if not p.exists():
            continue
        for x in json.loads(p.read_text(encoding='utf-8')):
            builder.add('drive:'+x['id'], x.get('title', x['id']), 'document', 'extracted_unverified',
                        path=x.get('path'), url=x.get('url'), status=None if x.get('path') else 'unavailable',
                        details={'manifest': str(p.relative_to(root)), 'speaker': 'unknown'})
    for filename in ('manifest.json', 'spreadsheets-manifest.json'):
        p = coll/'text/local'/filename
        if not p.exists():
            continue
        for x in json.loads(p.read_text(encoding='utf-8')):
            original = x['source']
            typ = 'spreadsheet' if filename.startswith('spreadsheet') else 'document'
            builder.add('local:'+digest(original.encode())[:20], Path(original).name, typ,
                        'extracted_unverified', path=x.get('text'), original_path=original,
                        status=None if x.get('text') else 'unavailable',
                        details={'manifest': str(p.relative_to(root)), 'speaker': 'unknown'})
    for group in ('local-asr', 'podcast-asr'):
        for p in sorted((coll/'transcripts'/group).glob('*/metadata.json')):
            x = json.loads(p.read_text(encoding='utf-8'))
            ident = x['id']
            text = p.parent/(ident+'.txt')
            builder.add(group+':'+ident, x.get('source_title') or ident, 'transcript',
                        x.get('status', 'unknown'), path=str(text.relative_to(root)),
                        url=x.get('source') if str(x.get('source', '')).startswith('http') else None,
                        details={'metadata': str(p.relative_to(root)), 'speaker': 'unknown',
                                 'media_url': x.get('media_url')})
    # Quarantined machine output is recorded, but never indexed for answering.
    for p in sorted((coll/'transcripts/quarantine').glob('*/metadata.json')):
        x = json.loads(p.read_text(encoding='utf-8'))
        builder.add('quarantine:'+x['id'], x['id'], 'transcript', x.get('status', 'quarantined'),
                    url=x.get('source'), status='quarantined', details={'metadata': str(p.relative_to(root))})
    for p in sorted((coll/'transcripts/ocr').glob('*/metadata.json')):
        x = json.loads(p.read_text(encoding='utf-8'))
        t = p.parent/'frames-raw.txt'
        builder.add('ocr:'+p.parent.name, p.parent.name, 'ocr', x.get('status', 'ocr_unverified'),
                    path=str(t.relative_to(root)), url=x.get('source'),
                    details={'metadata': str(p.relative_to(root)), 'speaker': 'unknown'})


def build(root: Path, destination: Path):
    root = root.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.clec-build-', suffix='.sqlite', dir=destination.parent)
    os.close(fd)
    try:
        db = sqlite3.connect(tmp)
        db.execute('PRAGMA foreign_keys=ON')
        create_schema(db)
        builder = Builder(root, db)
        collect_sources(builder)
        revision = dt.datetime.now(dt.timezone.utc).isoformat()
        db.executemany('INSERT INTO meta VALUES (?,?)', [('schema_version', str(SCHEMA_VERSION)),
                        ('revision', revision), ('root', str(root))])
        db.commit()
        result = {'index_revision': revision, 'sources': db.execute('SELECT count(*) FROM source').fetchone()[0],
                  'chunks': builder.count, 'statuses': dict(db.execute('SELECT status,count(*) FROM source GROUP BY status'))}
        db.close()
        os.replace(tmp, destination)
        return result
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
