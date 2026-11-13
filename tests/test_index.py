import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from clec_kb.cli import connect, read, search, source, status
from clec_kb.core import build
from clec_kb.digests import build_digests, get_digest
from clec_kb.semantic import windows, model_fingerprint, search_semantic, MODEL
from clec_kb.research import research, keyword_query
from clec_kb.claim_checks import check_claim


class KnowledgeIndexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.coll = self.root / 'collection'
        folder = self.coll / 'sources/drive/archive-transcripts'
        folder.mkdir(parents=True)
        files = {
            '001.srt': '1\n00:00:00,000 --> 00:00:02,000\n退休以後，股票現金流。\n\n2\n00:00:02,000 --> 00:00:04,000\n代碼 00662。\n',
            '001.txt': '退休以後，股票現金流。\n\n代碼 00662。\n',
            '001.md': '# 标题\n\n## 0:00\n退休以後，股票現金流。\n\n## 0:02\n代碼 00662。\n',
            '002.srt': '', '002.txt': '', '002.md': '# 空的标题\n'}
        for name, contents in files.items():
            (folder / name).write_text(contents, encoding='utf-8')
        records = []
        for group, title in [('001', '00012 退休 2025年1月24日.zip'), ('002', '00176 2025年2月1日.zip')]:
            records.append({'id': group, 'outer_member': title, 'archive_source': 'https://example.com/archive',
                            'files': [{'path': str((folder / (group + ext)).relative_to(self.root)), 'original_name': group + ext} for ext in ('.srt', '.txt', '.md')]})
        manifest = self.coll / 'sources/drive/archive-transcripts-manifest.jsonl'
        manifest.write_text(''.join(json.dumps(x, ensure_ascii=False) + '\n' for x in records))
        web = self.coll / 'web/clectw/transcripts'
        web.mkdir(parents=True)
        (web/'one.txt').write_text('同名材料：這是不同的退休觀點，應該保留股票。', encoding='utf-8')
        (web/'two.txt').write_text('同名材料：這是另一篇內容，應該保留債券。', encoding='utf-8')
        (web/'unknown.txt').write_text('退休現金保障，54 歲和 50 倍支出。', encoding='utf-8')
        (web.parent/'episode-inventory.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False) + '\n' for x in [
            {'episode_id': 'one', 'title': '同名材料 2024年5月29日', 'transcript_status': 'automatic_unverified', 'transcript': str((web/'one.txt').relative_to(self.root)), 'url': 'https://example.com/one'},
            {'episode_id': 'two', 'title': '同名材料 2024年5月31日', 'transcript_status': 'automatic_unverified', 'transcript': str((web/'two.txt').relative_to(self.root)), 'url': 'https://example.com/two'},
            {'episode_id': 'unknown', 'title': '日期未知', 'transcript_status': 'automatic_unverified', 'transcript': str((web/'unknown.txt').relative_to(self.root))},
            {'episode_id': 'missing', 'title': '无内容', 'transcript_status': 'missing'},
        ]))
        quarantine = self.coll/'transcripts/quarantine/bad'
        quarantine.mkdir(parents=True)
        (quarantine/'metadata.json').write_text(json.dumps({'id': 'bad', 'status': 'suspected_hallucination_do_not_use'}))
        (quarantine/'bad.txt').write_text('退休股票绝密内容', encoding='utf-8')
        self.dbpath = self.root/'index/db.sqlite'
        build(self.root, self.dbpath)
        self.db = connect(self.dbpath)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def query(self, text, **kw):
        return search(self.db, argparse.Namespace(query=text, type=kw.get('type'), after=kw.get('after'), before=kw.get('before'), limit=20), kw.get('timeline', False))

    def test_distinct_empty_and_equivalent_formats(self):
        report = status(self.db)
        self.assertEqual(report['statuses']['empty'], 2)
        self.assertEqual(report['statuses']['heading_only'], 1)
        self.assertEqual(report['statuses']['duplicate_representation'], 2)
        self.assertEqual(report['statuses']['unavailable'], 1)
        self.assertEqual(report['statuses']['quarantined'], 1)
        self.assertEqual(self.query('绝密内容')['results'], [])
        self.assertEqual(source(self.db, self.root, 'archive:001:text')['duplicate_of'], 'archive:001:subtitle')
        self.assertEqual({x['source_id'] for x in self.query('同名材料')['results']}, {'clectw:one', 'clectw:two'})

    def test_chinese_short_terms_codes_and_evidence_location(self):
        results = self.query('股票')['results']
        self.assertEqual({x['source_id'] for x in results}, {'archive:001:subtitle', 'clectw:one'})
        result = self.query('退休 00662')['results'][0]
        self.assertEqual(result['source_id'], 'archive:001:subtitle')
        self.assertEqual(result['locator']['start'], '00:00:00,000')
        self.assertEqual(result['locator']['line_start'], 2)
        expanded = read(self.db, self.root, result['evidence_id'], 1)
        self.assertEqual(expanded['source']['file_status'], 'verified')
        self.assertIn('代碼 00662', expanded['chunks'][0]['text'])
        self.assertEqual(expanded['chunks'][0]['locator']['timestamp_scope'], 'source_subtitle_only')
        self.assertEqual(self.query('现金流')['results'][0]['source_id'], 'archive:001:subtitle')
        self.assertEqual(self.query('54岁 50倍')['results'][0]['source_id'], 'clectw:unknown')

    def test_date_filter_and_changed_file_rejected(self):
        filtered = self.query('退休', after='2025-01-01')
        self.assertEqual(filtered['unknown_date_sources_excluded'], 1)
        result = filtered['results']
        self.assertEqual([x['source_id'] for x in result], ['archive:001:subtitle'])
        p = self.root / 'collection/sources/drive/archive-transcripts/001.srt'
        p.write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed'):
            read(self.db, self.root, result[0]['evidence_id'], 0)
        self.assertEqual(source(self.db, self.root, 'archive:001:subtitle')['file_status'], 'changed')

    def test_page_through_all_passages(self):
        args = argparse.Namespace(query='退休', type=None, source=None, after=None, before=None,
                                  limit=1, all_passages=True, offset=0)
        first = search(self.db, args)
        self.assertIsNotNone(first['next_offset'])
        args.offset = first['next_offset']
        second = search(self.db, args)
        self.assertNotEqual(first['results'][0]['evidence_id'], second['results'][0]['evidence_id'])

    def test_verbatim_digest_covers_indexed_chunks_and_rejects_stale_revision(self):
        path = self.root/'index/digests.jsonl'
        result = build_digests(self.dbpath, path)
        self.assertEqual(result['chunks_covered'], status(self.db)['chunks'])
        d = get_digest(self.db, path, 'archive:001:subtitle')
        extract = d['extracts'][0]
        original = self.db.execute('SELECT text FROM chunk WHERE id=?', (extract['evidence_id'],)).fetchone()[0]
        self.assertEqual(original[extract['start_in_chunk']:extract['end_in_chunk']], extract['text'])
        other = self.root/'index/other.sqlite'
        build(self.root, other)
        with connect(other) as rebuilt:
            with self.assertRaisesRegex(ValueError, '版本不一致'):
                get_digest(rebuilt, path, 'archive:001:subtitle')

    def test_semantic_windows_overlap_and_cover_text(self):
        text = '股票現金' * 141
        spans = list(windows(text))
        self.assertEqual(spans[0][0], 0)
        self.assertEqual(spans[-1][1], len(text))
        self.assertTrue(all(a[1] >= b[0] for a, b in zip(spans, spans[1:])))
        with self.assertRaisesRegex(ValueError, '非空'):
            search_semantic(self.root, self.db, self.root/'index/semantic', '   ')

    def test_model_fingerprint_detects_changed_weights(self):
        folder = self.root / MODEL
        folder.mkdir(parents=True)
        for name in ('config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'vocab.txt'):
            (folder/name).write_text(name)
        before = model_fingerprint(self.root)
        (folder/'model.safetensors').write_text('changed')
        self.assertNotEqual(before, model_fingerprint(self.root))

    def test_research_combines_semantic_and_lexical_evidence(self):
        evidence = self.query('退休')['results'][0]
        fake = {'results': [dict(evidence)]}
        with patch('clec_kb.research.search_semantic', return_value=fake):
            result = research(self.root, self.db, self.root/'index/semantic', '退休股票', limit=10, terms='退休')
        hit = next(x for x in result['results'] if x['source_id'] == evidence['source_id'])
        self.assertEqual(hit['file_status'], 'verified')
        self.assertEqual(set(hit['retrieval']), {'semantic_rank', 'lexical_rank'})
        self.assertIn('54岁', keyword_query('54岁来信者如何处理退休现金？'))

    def test_claim_warnings_for_omitted_conditions_and_invented_quotes(self):
        quote = '如果您打算在臺灣生活，且資金回到臺灣而沒有稅務問題，我建議全部匯回臺灣。'
        result = check_claim(quote, quote, '老師建議將資金匯回臺灣。')
        self.assertEqual(result['status'], 'needs_review')
        self.assertTrue(any('条件' in x for x in result['warnings']))
        quote2 = '所以你的現金部位儘量永遠高過你的欠款。'
        self.assertEqual(check_claim(quote2, quote2, '現金部位要永遠高過欠款。')['status'], 'needs_review')
        self.assertFalse(check_claim(quote2, '不存在的原文', '示例')['quote_exact'])


if __name__ == '__main__':
    unittest.main()
