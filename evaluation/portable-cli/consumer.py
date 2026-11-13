#!/usr/bin/env python3
"""Check a packed installed CLI against a disposable, synced sample data directory.
Usage: consumer.py CLEC DATA_DIR OUTPUT.json
"""
import json
import os
from pathlib import Path
import subprocess
import sys

cli, data, output = sys.argv[1:]
env = {k: v for k, v in os.environ.items() if not any(x in k.upper() for x in ('API_KEY', 'TOKEN', 'SECRET'))}
results = []

def call(*args, ok=True):
    try:
        p = subprocess.run([cli, *args, '--data-dir', data], capture_output=True, text=True, env=env, timeout=60)
        value = json.loads(p.stdout)
        item = {'args': args, 'exit': p.returncode, 'value': value, 'stderr': p.stderr}
        results.append(item)
        assert (p.returncode == 0) == ok and value['ok'] == ok, item
        return value
    except subprocess.TimeoutExpired:
        results.append({'args': args, 'timeout': True})
        raise

try:
    status = call('status')
    release = status['release']
    result = call('search', '513100 拆股', '--limit', '8')
    assert result['hits'] and result['terms']
    hit = result['hits'][0]
    assert len(hit['preview'].encode('utf-16-le')) // 2 <= 320
    evidence = call('read', hit['ref'])
    assert evidence['text'] and len(evidence['text'].encode('utf-16-le')) // 2 <= 5000
    source = call('source', hit['sourceRef'], '--offset', '0', '--limit', '1')
    assert len(source['sections']) == 1
    for query in ('退休', '退休 513100', '513100', '拆股', '拆股 2013'):
        call('search', query, '--limit', '8')
    call('search', '退休', '--limit', '0', ok=False)
    call('search', 'x' * 513, ok=False)
    call('source', hit['sourceRef'], '--limit', '101', ok=False)
    stale = call('read', '0' * 64 + ':' + hit['ref'].split(':')[1], ok=False)
    assert stale['error']['code'] == 'VERSION_UNAVAILABLE'
    call('read', release + ':' + '0' * 64, ok=False)
    call('read', 'not-a-reference', ok=False)
finally:
    Path(output).write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
