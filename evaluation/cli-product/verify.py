#!/usr/bin/env python3
"""Exercise an installed CLEC CLI against the frozen product contract and real data."""
import argparse
import hashlib
import functools
import http.server
import json
import os
import pty
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

HOME = Path.home()
RUN = HOME / '.cache/clec/runs/cli-product-20261113/verification'
DATA = HOME / '.cache/clec/runs/portable-cli-20261113/verification/relocated-data'
SAMPLE = HOME / '.cache/clec/runs/portable-cli-20261113/verification/sample-release/manifest.json'
QUERIES = ['關於 clec.md', 'clec.md 原始素材 知識庫', '資產配置 終極問題 00575', '現金是空氣 上班 生活費', '聰明再平衡 先看這裡', '再平衡 工作收入 退休', 'Rental Property Index Funds retirement', '2018 實體課程 IRR 十萬 十五年', 'IRA 放空 IRS 官方', '00335B 退休金 年開銷']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, help='absolute path to Node executable')
    parser.add_argument('--cli', required=True, help='absolute path to installed node_modules/.bin/clec')
    parser.add_argument('--label', required=True)
    args = parser.parse_args()
    RUN.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PATH=str(Path(args.node).parent) + os.pathsep + os.environ.get('PATH', ''))
    results = []
    paired = []
    log = RUN / (args.label + '.jsonl')
    log.write_text('')

    def run(*argv, data=DATA, stdin=None, timeout=60):
        command = [args.cli, *map(str, argv)]
        if data is not None:
            command += ['--data-dir', str(data)]
        proc = subprocess.run(command, input=stdin, text=True, capture_output=True, timeout=timeout, cwd=RUN, env=env)
        record = {'argv': command, 'exit': proc.returncode, 'stdout': proc.stdout, 'stderr': proc.stderr}
        with log.open('a') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
        return proc

    def check(name, fn):
        try:
            fn()
            results.append((name, 'PASS', ''))
        except Exception as exc:
            results.append((name, 'FAIL', str(exc)))
            print('FAIL', name, str(exc), flush=True)

    def envelope(proc, ok=True, code=None):
        assert proc.returncode == (0 if ok else code), f'exit {proc.returncode}, expected {0 if ok else code}: {proc.stderr[:500]}'
        assert not (proc.stderr if ok else proc.stdout), f'unexpected output: {(proc.stderr if ok else proc.stdout)[:500]}'
        obj = json.loads(proc.stdout if ok else proc.stderr)
        assert obj['schemaVersion'] == 1 and obj['ok'] is ok, obj
        if not ok:
            assert all(obj['error'].get(k) for k in ('code', 'message', 'remedy')), obj
        return obj['data'] if ok else obj['error']

    def j(*argv, **kw):
        return envelope(run(*argv, '--format', 'json', **kw))

    def failed(*argv, code=2, **kw):
        return envelope(run(*argv, '--format', 'json', **kw), False, code)

    db = next(DATA.glob('*.sqlite'))
    def db_hash():
        h = hashlib.sha256()
        with db.open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    original_db_hash = db_hash()

    with tempfile.TemporaryDirectory(dir=RUN, prefix=args.label + '-') as tmp:
        empty = Path(tmp) / 'data'
        def help_checks():
            for command in ([], ['--help'], ['-h'], ['help'], ['help', 'read'], ['read', '--help'], ['status', '--help'], ['version'], ['--version']):
                p = run(*command, data=empty)
                assert p.returncode == 0 and p.stdout and not p.stderr, (command, p.returncode, p.stderr)
            assert '0.2.0' in run('--version', data=empty).stdout
            j('help', 'read', data=empty)
            p = run('help', data=empty)
            assert not p.stdout.lstrip().startswith('{'), 'redirected default output is JSON'
        check('help/version without data; text default', help_checks)
        def flags():
            j('--data-dir', str(empty), 'status', data=None)
            j('status', data=empty)
            for argv in [('status', '--wat'), ('status', 'extra'), ('status', '--format', 'json'), ('search', 'one', 'two'), ('search', '--limit')]:
                failed(*argv, data=empty)
        check('global flags and argument rejection', flags)
        def status():
            result = j('status', data=empty)
            assert result['ready'] is False, result
        check('no-data status', status)
        check('no-data search', lambda: failed('search', 'test', data=empty, code=3))
        def sync():
            j('sync', '--manifest', str(SAMPLE), data=empty)
            first = j('status', data=empty)
            assert first['ready'] is True, first
            j('sync', data=empty)
            handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SAMPLE.parent))
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                failed('sync', '--manifest', f'http://127.0.0.1:{server.server_port}/missing.json', data=empty, code=4)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
            after = j('status', data=empty)
            assert first == after, (first, after)
            j('sync', data=empty)
        check('sync initial, repeat, failed origin preserves configuration', sync)
        def config_failure():
            target = Path(tmp) / 'config-failure'
            (target / 'config.json').mkdir(parents=True)
            error = failed('sync', '--manifest', str(SAMPLE), data=target, code=4)
            expected_release = json.loads(SAMPLE.read_text())['sha256']
            assert error['code'] == 'CONFIG_SAVE_FAILED' and error['release'] == expected_release, error
            assert j('sources', data=target)['release'] == expected_release
        check('config save failure reports activated and usable release', config_failure)
        def bad_url():
            p = run('sync', '--manifest', 'http://example.com/manifest.json', '--format', 'json', data=empty)
            assert p.returncode != 0 and not p.stdout, (p.returncode, p.stdout)
            error = json.loads(p.stderr)['error']
            assert error.get('remedy'), error
        check('unsafe URL rejected with remedy', bad_url)
        def malformed_file_urls():
            for url in ('file://remote/manifest.json', 'file:///tmp/a%2Fb'):
                error = failed('sync', '--manifest', url, data=empty)
                assert error['code'] == 'INVALID_URL', error
        check('invalid file URL classification', malformed_file_urls)

        state = {}
        def pages():
            first = j('search', '退休', '--limit', '2')
            second = j('search', '退休', '--limit', '2', '--offset', '2', '--release', first['release'])
            whole = j('search', '退休', '--limit', '4', '--release', first['release'])
            assert first['hits'] + second['hits'] == whole['hits'], 'page partition differs from whole'
            assert first['page']['nextOffset'] == 2, first['page']
            assert first == j('search', '退休', '--limit', '2'), 'results not deterministic'
            counts = {}
            for hit in whole['hits']:
                key = hit['sourceRef']
                counts[key] = counts.get(key, 0) + 1
            assert max(counts.values()) <= 2, counts
            failed('search', '退休', '--release', '0' * 64, code=3)
            assert not j('search', '退休', '--offset', '10000000')['hits']
            failed('search', '退休', '--offset', '10000001')
            hit = whole['hits'][0]
            filtered = j('search', '退休', '--source', hit['sourceRef'])
            assert filtered['hits'] and all(h['sourceRef'] == hit['sourceRef'] for h in filtered['hits'])
            failed('search', '退休', '--source', hit['sourceRef'], '--release', '0' * 64)
            with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as conn:
                original = conn.execute('SELECT original FROM sources WHERE id=?', (hit['source']['id'],)).fetchone()[0]
            assert hit['previewKind'] == 'match' and hit['preview'] in original, hit
            state['hit'] = hit
            state['release'] = whole['release']
        check('search pagination, deterministic diversity, stale release', pages)
        def sources():
            a = j('sources', 'clec.md', '--limit', '2')
            assert a['items'], a
            assert all(all(k in x for k in ('sourceRef', 'title', 'path', 'type', 'date', 'dateBasis', 'quality', 'sectionCount')) for x in a['items']), a['items'][0]
            state['source'] = a['items'][0]['sourceRef']
            b = j('source', state['source'], '--limit', '1')
            assert b['sections'], b
        check('source discovery and source contents', sources)
        def reads():
            hit = state['hit']
            ref = hit['ref']
            one = j('read', ref, '--context', '0')
            two = j('read', '--stdin', '--context', '0', stdin=ref + '\n\n' + ref + '\n')
            assert len(one['items']) == 1 and len(two['items']) == 2
            assert two['items'][0] == two['items'][1] == one['items'][0]
            context = j('read', ref, '--context', '1')['items'][0]
            assert context['ref'] == ref and context['text'] == one['items'][0]['text']
            assert all(k in context for k in ('sourceRef', 'source', 'section', 'context', 'previous', 'next', 'warnings'))
            with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as conn:
                row = conn.execute('SELECT s.original, t.start, t.end FROM sections t JOIN sources s ON s.id=t.source_id WHERE t.id=?', (ref.split(':')[1],)).fetchone()
            assert row is not None
            original, start, end = row
            exact = original.encode('utf-16-le')[start * 2:end * 2].decode('utf-16-le')
            assert context['text'] == exact, 'read text differs from original UTF-16 span'
            assert hashlib.sha256(original.encode()).hexdigest() == context['source']['contentHash'], 'original hash differs from provenance'
            error = failed('read', '--stdin', stdin=ref + '\nnot-a-ref\n')
            assert error.get('inputIndex') is not None, error
            failed('read', ref, '--stdin', stdin=ref + '\n')
            missing = state['release'] + ':' + '0' * 64
            error = failed('read', ref, missing, code=3)
            assert error.get('inputIndex') == 1, error
            mixed = '0' * 64 + ':' + ref.split(':')[1]
            error = failed('read', ref, mixed)
            assert error.get('inputIndex') == 1, error
            failed('read', '--stdin', stdin=(ref + '\n') * 51)
            failed('read', '--stdin', stdin='x' * 65537)
            master, slave = pty.openpty()
            try:
                p = subprocess.run([args.cli, 'read', '--stdin', '--format', 'json', '--data-dir', str(DATA)], stdin=slave, capture_output=True, text=True, timeout=15, cwd=RUN, env=env)
                envelope(p, False, 2)
            finally:
                os.close(master)
                os.close(slave)
            failed('read', '0' * 64 + ':' + '0' * 64, code=3)
        check('single/batch/context and atomic stdin failures', reads)
        def adjacent_spans():
            with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as conn:
                section_id = conn.execute('SELECT id FROM sections WHERE ordinal=1 AND source_id IN (SELECT source_id FROM sections GROUP BY source_id HAVING count(*)>=3) LIMIT 1').fetchone()[0]
                item = j('read', db.stem + ':' + section_id, '--context', '1')['items'][0]
                assert len(item['context']) == 2, len(item['context'])
                for part in [item, *item['context']]:
                    original, start, end = conn.execute('SELECT s.original, t.start, t.end FROM sections t JOIN sources s ON s.id=t.source_id WHERE t.id=?', (part['ref'].split(':')[1],)).fetchone()
                    assert part['section']['start'] == start and part['section']['end'] == end
                    assert part['text'] == original.encode('utf-16-le')[start * 2:end * 2].decode('utf-16-le')
        check('adjacent contextual evidence preserves exact spans', adjacent_spans)
        def epipe():
            p = subprocess.Popen([args.cli, 'sources', '--limit', '50', '--format', 'json', '--data-dir', str(DATA)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=RUN, env=env)
            p.stdout.close()
            err = p.stderr.read()
            rc = p.wait(timeout=60)
            assert rc == 0 and not err, (rc, err[:500])
        check('closed stdout EPIPE', epipe)
        def pipeline():
            producer = subprocess.Popen([args.cli, 'search', '退休', '--limit', '2', '--format', 'json', '--data-dir', str(DATA)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=RUN)
            extract = subprocess.Popen([sys.executable, '-c', 'import json,sys; print("\\n".join(h["ref"] for h in json.load(sys.stdin)["data"]["hits"]))'], stdin=producer.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=RUN)
            producer.stdout.close()
            consumer = subprocess.Popen([args.cli, 'read', '--stdin', '--context', '0', '--format', 'json', '--data-dir', str(DATA)], stdin=extract.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=RUN)
            extract.stdout.close()
            out, err = consumer.communicate(timeout=60)
            extract_err = extract.stderr.read()
            producer_err = producer.stderr.read()
            assert producer.wait(timeout=60) == extract.wait(timeout=60) == consumer.returncode == 0, (producer_err, extract_err, err)
            assert not producer_err and not extract_err and not err
            assert len(json.loads(out)['data']['items']) == 2
        check('search to reference extractor to read process pipe', pipeline)
        def probes():
            evaldir = HOME / '.cache/clec/runs/cli-product-20261113/evaluation'
            gold = json.loads((evaldir / 'development-gold.json').read_text())
            baseline = [json.loads(line) for line in (evaldir / 'baseline-development.jsonl').read_text().splitlines()]
            for i, query in enumerate(QUERIES, 1):
                result = j('search', query, '--limit', '5')
                assert 'hits' in result and 'release' in result, (i, result)
                expected = gold[i - 1]['source_id']
                oldhits = json.loads(baseline[i - 1]['stdout'])['hits']
                paired.append({'id': gold[i - 1]['id'], 'baseline_designated_source': any(h['source']['id'] == expected for h in oldhits), 'candidate_designated_source': any(h['source']['id'] == expected for h in result['hits']), 'baseline_distinct_sources': len({h['source']['id'] for h in oldhits}), 'candidate_distinct_sources': len({h['source']['id'] for h in result['hits']})})
        check('ten paired development search probes', probes)
    check('full corpus database unchanged', lambda: (_ for _ in ()).throw(AssertionError('database hash changed')) if db_hash() != original_db_hash else None)
    summary = {'label': args.label, 'node': args.node, 'cli': args.cli, 'paired_development_navigation': paired, 'checks': [{'name': n, 'status': s, 'detail': d} for n, s, d in results]}
    (RUN / (args.label + '-summary.json')).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if any(s == 'FAIL' for _, s, _ in results) else 0


if __name__ == '__main__':
    sys.exit(main())
