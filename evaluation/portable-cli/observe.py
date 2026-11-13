#!/usr/bin/env python3
"""Record real retrieval observations for the development cases only.

Usage: observe.py CLEC DATA_DIR WORKSPACE OUTPUT [REFORMULATIONS.json]
Optional reformulations map case IDs to queries selected from the question alone.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

cli, data_dir, workspace, output = sys.argv[1:5]
reformulations = json.loads(Path(sys.argv[5]).read_text()) if len(sys.argv) > 5 else {}
cases = [json.loads(line) for line in Path('evaluation/backend-e2e/development.jsonl').read_text().splitlines()]
env = {key: value for key, value in os.environ.items() if not any(x in key.upper() for x in ('API_KEY', 'TOKEN', 'SECRET'))}

def call(*args):
    try:
        p = subprocess.run([cli, *args, '--data-dir', data_dir], capture_output=True, text=True, env=env, timeout=30)
    except subprocess.TimeoutExpired:
        return {'timeout': True}
    try:
        value = json.loads(p.stdout)
    except json.JSONDecodeError:
        value = None
    return {'exit': p.returncode, 'json': value, 'raw_stdout': p.stdout if value is None else None, 'stderr': p.stderr}

def units(s):
    return len(s.encode('utf-16-le')) // 2

def observe(query, evidence):
    result = call('search', query, '--limit', '8')
    search = result.get('json') or {}
    reads = []
    seen = set()
    def read(ref, rank, context):
        if not isinstance(ref, str) or ref in seen:
            return
        seen.add(ref)
        item = call('read', ref)
        item.update({'rank': rank, 'ref': ref, 'context': context})
        reads.append(item)
    for rank, hit in enumerate(search.get('hits', []), 1):
        read(hit.get('ref'), rank, False)
    for item in list(reads):
        value = item.get('json') or {}
        read(value.get('previous'), item['rank'], True)
        read(value.get('next'), item['rank'], True)
    grades = []
    for e in evidence:
        if e.get('error') or not e.get('span_matches') or e.get('actual_sha256') != e.get('expected_sha256'):
            grades.append({'path': e['path'], 'result': 'not evaluable'})
            continue
        intervals, ranks = [], []
        for item in reads:
            value = item.get('json') or {}
            if not value.get('ok') or (value.get('source') or {}).get('path') != e['path']:
                continue
            section = value.get('section') or {}
            start, end = section.get('start'), section.get('end')
            if not isinstance(start, int) or not isinstance(end, int):
                continue
            original = (Path(workspace) / e['path']).read_bytes().decode('utf-8')
            encoded = original.encode('utf-16-le')
            exact = encoded[start * 2:end * 2].decode('utf-16-le') == value.get('text')
            if exact and start < e['end'] and end > e['start']:
                intervals.append((max(start, e['start']), min(end, e['end'])))
                ranks.append(item['rank'])
        cursor = e['start']
        for start, end in sorted(intervals):
            if start > cursor:
                break
            cursor = max(cursor, end)
        grades.append({'path': e['path'], 'result': 'full' if cursor >= e['end'] else 'partial' if intervals else 'miss', 'ranks': sorted(set(ranks))})
    return {'query': query, 'search': result, 'reads': reads, 'evidence': grades}

with Path(output).open('w') as out:
    for case in cases:
        evidence = []
        for item in case['evidence']:
            path = Path(workspace) / item['path']
            if not path.is_file():
                evidence.append({'path': item['path'], 'error': 'source unavailable'})
                continue
            raw = path.read_bytes()
            lines = raw.decode('utf-8').splitlines(keepends=True)
            before = ''.join(lines[:item['line_start'] - 1])
            span = ''.join(lines[item['line_start'] - 1:item['line_end']]).rstrip('\r\n')
            evidence.append({'path': item['path'], 'expected_sha256': item['sha256'],
                'actual_sha256': hashlib.sha256(raw).hexdigest(), 'line_start': item['line_start'],
                'line_end': item['line_end'], 'span_matches': span == item['span_text'],
                'start': units(before), 'end': units(before + span)})
        conversation = case.get('conversation', {})
        dependent = conversation.get('mode') == 'ordered' and conversation.get('previous_case_id') is not None
        row = {'id': case['id'], 'question': case['question'], 'evidence_checks': evidence,
               'context_dependent': dependent, 'first': observe(case['question'], evidence)}
        if case['id'] in reformulations:
            row['reformulated'] = observe(reformulations[case['id']], evidence)
        out.write(json.dumps(row, ensure_ascii=False) + '\n')
        out.flush()
