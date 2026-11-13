#!/usr/bin/env python3
"""Compare a publisher artifact with the immutable canonical evidence database.

Usage: parity.py CANONICAL_DB CORPUS_DB [SAMPLE_IDENTITIES.json]
Both files are opened read-only. A sample selects the source IDs to compare.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

canonical_path, corpus_path = map(Path, sys.argv[1:3])
selected = None if len(sys.argv) < 4 else {x['id'] for x in json.loads(Path(sys.argv[3]).read_text())}

def connect(path):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)

def load_sources(db):
    return {row[0]: (row[1], json.loads(row[2]), row[3]) for row in db.execute('select id, version, record, original from sources') if selected is None or row[0] in selected}

old, new = connect(canonical_path), connect(corpus_path)
a, b = load_sources(old), load_sources(new)
errors = []
if a.keys() != b.keys():
    errors.append({'kind': 'source_ids', 'missing': sorted(a.keys() - b.keys()), 'extra': sorted(b.keys() - a.keys())})
if selected is not None and a.keys() != selected:
    errors.append({'kind': 'sample_ids_not_canonical', 'missing': sorted(selected - a.keys())})
for sid in a.keys() & b.keys():
    version, record, original = a[sid]
    if (version, record, original) != b[sid]:
        errors.append({'kind': 'source_mismatch', 'id': sid, 'version': version != b[sid][0],
                       'record': record != b[sid][1], 'original': original != b[sid][2]})
    if hashlib.sha256(b[sid][2].encode('utf-8')).hexdigest() != record['contentHash']:
        errors.append({'kind': 'content_hash', 'id': sid})

def old_sections(db):
    for sid, source, ordinal, record in db.execute('select id,source_id,ordinal,record from sections'):
        if selected is None or source in selected:
            r = json.loads(record)
            yield sid, (source, ordinal, r['start'], r['end'], r['boundary'])

def new_sections(db):
    for sid, source, ordinal, start, end, boundary in db.execute('select id,source_id,ordinal,start,end,boundary from sections'):
        if selected is None or source in selected:
            yield sid, (source, ordinal, start, end, boundary)

sa, sb = dict(old_sections(old)), dict(new_sections(new))
if sa.keys() != sb.keys():
    errors.append({'kind': 'section_ids', 'missing': sorted(sa.keys() - sb.keys()), 'extra': sorted(sb.keys() - sa.keys())})
for sid in sa.keys() & sb.keys():
    if sa[sid] != sb[sid]:
        errors.append({'kind': 'section_mismatch', 'id': sid, 'expected': sa[sid], 'actual': sb[sid]})
report = {'canonical': str(canonical_path), 'corpus': str(corpus_path), 'sources': len(b), 'sections': len(sb),
          'error_count': len(errors), 'errors': errors[:100]}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(bool(errors))
