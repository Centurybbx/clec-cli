from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sqlite3
import sys
from pathlib import Path

from .core import build, digest, normalize


def connect(path):
    if not path.exists():
        raise ValueError('索引不存在，请先运行 clec build')
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def source_record(row):
    data = dict(row)
    data.pop('search_meta', None)
    data['details'] = json.loads(data['details'])
    return data


def verify(root, source):
    if not source['path'] or not source['sha256']:
        return 'unavailable'
    try:
        return 'verified' if digest((root / source['path']).read_bytes()) == source['sha256'] else 'changed'
    except FileNotFoundError:
        return 'missing'


def clauses(query, args, include_dates=True):
    terms = [normalize(x) for x in query.split() if x.strip()]
    if not terms:
        raise ValueError('请输入非空查询词')
    spaced_numeric = lambda x: bool(re.search(r'\d.*[\u4e00-\u9fff%]', x))
    long = [x for x in terms if len(x) >= 3 and not spaced_numeric(x)]
    short = [x for x in terms if len(x) < 3 or spaced_numeric(x)]
    where, params = [], []
    if long:
        where.append('chunk_fts MATCH ?')
        params.append(' AND '.join('"' + t.replace('"', '""') + '"' for t in long))
    for term in short:
        if spaced_numeric(term):
            compact = lambda col: f"replace(replace(replace({col}, ' ', ''), char(10), ''), char(9), '')"
            where.append(f'(instr({compact("c.search_text")}, ?) > 0 OR instr({compact("s.search_meta")}, ?) > 0)')
        else:
            where.append('(instr(c.search_text, ?) > 0 OR instr(s.search_meta, ?) > 0)')
        params.extend([term, term])
    if args.type:
        where.append('s.type = ?')
        params.append(args.type)
    if getattr(args, 'source', None):
        where.append('s.id = ?')
        params.append(args.source)
    if include_dates and args.after:
        where.append('s.date >= ?')
        params.append(args.after)
    if include_dates and args.before:
        where.append('s.date <= ?')
        params.append(args.before)
    return long, where, params


def search(db, args, timeline=False):
    long, conditions, params = clauses(args.query, args)
    join = 'JOIN chunk_fts ON chunk_fts.chunk_id = c.id' if long else ''
    from_sql = f'FROM chunk c JOIN source s ON s.id=c.source_id {join} WHERE ' + ' AND '.join(conditions)
    # Limit scanning results explicitly; do not imply that a top-k result is exhaustive.
    window = max(500, min(5000, args.limit * 50))
    order_params = []
    if timeline:
        order = 's.date IS NULL, s.date, s.id, c.ordinal'
    elif long:
        order = 'bm25(chunk_fts), s.id, c.ordinal'
    else:
        # Short Chinese words cannot use the trigram index. Rank by occurrence
        # in the title and passage instead of alphabetically by source ID.
        terms = [normalize(x) for x in args.query.split() if x.strip()]
        parts = []
        for term in terms:
            parts.append('(3 * (length(s.search_meta)-length(replace(s.search_meta, ?, \'\'))) + '
                         '(length(c.search_text)-length(replace(c.search_text, ?, \'\')))) / ?')
            order_params.extend((term, term, len(term)))
        order = '(' + ' + '.join(parts) + ') DESC, s.id, c.ordinal'
    sql = f'''SELECT c.id AS evidence_id, c.source_id, c.ordinal, c.text, c.locator, c.fingerprint,
                     s.title, s.type, s.quality, s.date, s.date_basis, s.url, s.path, s.sha256
              {from_sql} ORDER BY {order} LIMIT ? OFFSET ?'''
    offset = getattr(args, 'offset', 0)
    rows = db.execute(sql, (*params, *order_params, window, offset)).fetchall()
    count = db.execute(f'SELECT count(*) {from_sql}', params).fetchone()[0]
    unknown = None
    if args.after or args.before:
        _, without_dates, raw_params = clauses(args.query, args, include_dates=False)
        without_dates.append('s.date IS NULL')
        unknown = db.execute(f'SELECT count(DISTINCT s.id) FROM chunk c JOIN source s ON s.id=c.source_id {join} WHERE ' + ' AND '.join(without_dates), raw_params).fetchone()[0]
    matches, seen_sources, seen_text = [], set(), set()
    examined = 0
    for row in rows:
        examined += 1
        d = dict(row)
        if not getattr(args, 'all_passages', False) and (d['source_id'] in seen_sources or d['fingerprint'] in seen_text):
            continue
        seen_sources.add(d['source_id'])
        seen_text.add(d['fingerprint'])
        d.pop('fingerprint')
        d['locator'] = json.loads(d['locator'])
        matches.append(d)
        if len(matches) >= args.limit:
            break
    next_offset = offset + examined if offset + examined < count else None
    return {'query': args.query, 'order': 'date' if timeline else ('bm25' if long else 'term_frequency'), 'results': matches,
            'matching_chunks': count, 'matching_chunks_scanned_max': window,
            'offset': offset, 'next_offset': next_offset,
            'results_may_be_incomplete': offset > 0 or next_offset is not None,
            'unknown_date_sources_excluded': unknown,
            'note': '结果按资料折叠；同文不代表独立证据。日期为来源标称日期；引用前须运行 read 验证原文件。'}


def source(db, root, ident):
    row = db.execute('SELECT * FROM source WHERE id=?', (ident,)).fetchone()
    if row is None:
        raise ValueError('找不到来源：' + ident)
    result = source_record(row)
    result['file_status'] = verify(root, result)
    result['representations'] = [source_record(x) for x in db.execute('SELECT * FROM source WHERE family=? AND id<>? ORDER BY id', (row['family'], ident))] if row['family'] else []
    assessments = root/'collection/web/clec168/cross-source-assessments.json'
    if assessments.exists():
        matches = []
        for item in json.loads(assessments.read_text(encoding='utf-8')):
            is_source = result['url'] and item.get('source_url') == result['url']
            is_candidate = ident.startswith('clectw:') and any(c[1] == ident[7:] for c in item.get('candidate_matches', []))
            is_archive = result['family'] and any('archive:'+c.get('archive_id', '') == result['family'] for c in item.get('archive_id_candidates', []))
            if is_source or is_candidate or is_archive:
                matches.append({'source_url': item.get('source_url'), 'assessment': item.get('assessment'),
                                'candidate_matches': item.get('candidate_matches', []),
                                'archive_id_candidates': [c.get('archive_id') for c in item.get('archive_id_candidates', [])],
                                'status': 'unverified_candidate'})
        result['cross_source_candidates'] = matches
    result['evidence_count'] = db.execute('SELECT count(*) FROM chunk WHERE source_id=?', (ident,)).fetchone()[0]
    return result


def read(db, root, ident, context):
    row = db.execute('SELECT * FROM chunk WHERE id=?', (ident,)).fetchone()
    if row is None:
        raise ValueError('找不到证据片段：' + ident)
    src = source(db, root, row['source_id'])
    if src['file_status'] != 'verified':
        raise ValueError(f"原文件状态为 {src['file_status']}，旧索引不可用于引用；请重新构建索引")
    chunks = []
    for x in db.execute('SELECT * FROM chunk WHERE source_id=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal',
                        (row['source_id'], max(0, row['ordinal']-context), row['ordinal']+context)):
        chunks.append({'evidence_id': x['id'], 'ordinal': x['ordinal'], 'text': x['text'],
                       'locator': json.loads(x['locator']), 'selected': x['id'] == ident})
    return {'source': src, 'chunks': chunks,
            'note': '字幕时间仅适用于本字幕版本；自动转写、第三方摘要及文档提取均须按质量标记核实。'}


def status(db):
    def groups(col):
        return dict(db.execute(f'SELECT {col}, count(*) FROM source GROUP BY {col} ORDER BY {col}'))
    return {'index': dict(db.execute('SELECT key,value FROM meta')),
            'source_records': db.execute('SELECT count(*) FROM source').fetchone()[0],
            'chunks': db.execute('SELECT count(*) FROM chunk').fetchone()[0],
            'statuses': groups('status'), 'types': groups('type'), 'quality': groups('quality'),
            'source_dates': {'earliest': db.execute("SELECT min(date) FROM source WHERE status='ok'").fetchone()[0],
                             'latest': db.execute("SELECT max(date) FROM source WHERE status='ok'").fetchone()[0],
                             'unknown_indexed_sources': db.execute("SELECT count(*) FROM source WHERE status='ok' AND date IS NULL").fetchone()[0]},
            'note': '来源记录不等于独立节目；来源日期只从标题中提取，未知日期不计入时间范围。'}


def parser():
    p = argparse.ArgumentParser(description='本地 CLEC 资料索引，输出 JSON 供 Agent 使用')
    p.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    p.add_argument('--db', type=Path, help='索引路径，默认 ROOT/index/clec.sqlite3')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('build', help='从本地资料清单重建索引')
    sub.add_parser('status', help='查看索引覆盖与质量状态')
    sub.add_parser('semantic-build', help='构建可恢复的本地语义索引')
    sub.add_parser('digest-build', help='为所有正文构建原文导航摘录')
    brief = sub.add_parser('digest', help='查看指定资料的原文导航摘录')
    brief.add_argument('source_id')
    brief.add_argument('--offset', type=int, default=0)
    brief.add_argument('--limit', type=int, choices=range(1,101), default=10, metavar='1..100')
    sem = sub.add_parser('semantic-search', help='按自然语言检索语义相近的片段')
    sem.add_argument('query')
    sem.add_argument('--after')
    sem.add_argument('--before')
    sem.add_argument('--type', choices=('transcript','subtitle','article','summary','document','spreadsheet','ocr'))
    sem.add_argument('--limit', type=int, default=20, choices=range(1,101), metavar='1..100')
    research = sub.add_parser('research', help='合并自然语言语义检索与关键词检索')
    research.add_argument('query')
    research.add_argument('--terms', help='覆盖自动提取的关键词，空格分隔')
    research.add_argument('--after')
    research.add_argument('--before')
    research.add_argument('--limit', type=int, default=10, choices=range(1,101), metavar='1..100')
    for name in ('search', 'timeline'):
        s = sub.add_parser(name)
        s.add_argument('query', help='空格分隔的关键词，所有词都必须匹配')
        s.add_argument('--after', help='来源日期起点 YYYY-MM-DD')
        s.add_argument('--before', help='来源日期终点 YYYY-MM-DD')
        s.add_argument('--type', choices=('transcript','subtitle','article','summary','document','spreadsheet','ocr'))
        s.add_argument('--source', help='限定来源 ID')
        s.add_argument('--all-passages', action='store_true', help='保留同一资料的所有匹配片段')
        s.add_argument('--offset', type=int, default=0, help='从第几个匹配片段开始（用于翻页）')
        s.add_argument('--limit', type=int, default=20, choices=range(1, 101), metavar='1..100')
    r = sub.add_parser('read')
    r.add_argument('evidence_id')
    r.add_argument('--context', type=int, choices=range(0, 4), default=1)
    s = sub.add_parser('source')
    s.add_argument('source_id')
    check = sub.add_parser('check-claim', help='机械检查候选主张与指定原文引用')
    check.add_argument('evidence_id')
    check.add_argument('--quote', required=True)
    check.add_argument('--claim', required=True)
    return p


def main():
    args = parser().parse_args()
    root = args.root.resolve()
    dbpath = args.db.resolve() if args.db else root/'index/clec.sqlite3'
    try:
        if args.command in ('search', 'timeline', 'semantic-search', 'research', 'digest'):
            if getattr(args, 'offset', 0) < 0:
                raise ValueError('offset 不能为负数')
            if args.command != 'digest':
                for value in (args.after, args.before):
                    if value and dt.date.fromisoformat(value).isoformat() != value:
                        raise ValueError('日期必须采用 YYYY-MM-DD 格式')
                if args.after and args.before and args.after > args.before:
                    raise ValueError('起始日期不能晚于结束日期')
        if args.command == 'build':
            output = build(root, dbpath)
        elif args.command == 'semantic-build':
            from .semantic import build_semantic
            output = build_semantic(root, dbpath, root/'index/semantic')
        elif args.command == 'digest-build':
            from .digests import build_digests
            output = build_digests(dbpath, root/'index/navigation-extracts.jsonl')
        else:
            with connect(dbpath) as db:
                if args.command == 'status':
                    output = status(db)
                elif args.command in ('search', 'timeline'):
                    output = search(db, args, args.command == 'timeline')
                elif args.command == 'semantic-search':
                    from .semantic import search_semantic
                    output = search_semantic(root, db, root/'index/semantic', args.query,
                                             args.limit, args.after, args.before, args.type)
                elif args.command == 'research':
                    from .research import research
                    output = research(root, db, root/'index/semantic', args.query,
                                      args.limit, args.terms, args.after, args.before)
                elif args.command == 'digest':
                    from .digests import get_digest
                    src = source(db, root, args.source_id)
                    if src['file_status'] != 'verified':
                        raise ValueError('原文件已变化或无法读取，请重新构建索引')
                    output = get_digest(db, root/'index/navigation-extracts.jsonl', args.source_id,
                                        args.offset, args.limit)
                elif args.command == 'read':
                    output = read(db, root, args.evidence_id, args.context)
                elif args.command == 'check-claim':
                    from .claim_checks import check_claim
                    evidence = read(db, root, args.evidence_id, 0)
                    output = check_claim(evidence['chunks'][0]['text'], args.quote, args.claim)
                    output['evidence_id'] = args.evidence_id
                    output['source_quality'] = evidence['source']['quality']
                else:
                    output = source(db, root, args.source_id)
        print(json.dumps(output, ensure_ascii=False, indent=2))
    except (ValueError, sqlite3.Error, OSError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
