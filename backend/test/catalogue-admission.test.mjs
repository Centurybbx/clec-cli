import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { CatalogueContext } from '../dist/catalog/context.js';
import { webManifest, machineExtractions } from '../dist/catalog/adapters.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'clec-catalogue-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    ctx: new CatalogueContext(root),
    async put(path, text) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    },
  };
}

test('episode pages and introductions remain distinct from speech; listings stay metadata', async t => {
  const { ctx, put } = await fixture(t);
  for (const [site, paths] of [['clectw', ['/ep/00123', '/videos']], ['clec168', ['/video/00123', '/category/video']]]) {
    const rows = [];
    for (const [index, path] of paths.entries()) {
      const text = `collection/web/${site}/text/${index}.txt`;
      await put(text, '頁面摘要與讀者留言\n這不是已驗證的逐字講話。');
      rows.push({ url: `https://${site}.com${path}`, status: 'ok', text });
    }
    await put(`collection/web/${site}/manifest.jsonl`, rows.map(r => JSON.stringify(r)).join('\n'));
    await webManifest(ctx, site, new Map([['https://clectw.com/ep/00123', '00123 原始節目標題 2024-01-02']]));
  }
  const bodies = ctx.entries.filter(e => e.source?.type === 'curated');
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every(e => e.category === 'ready'));
  const episode = bodies.find(e => e.family === 'clectw-mixed-episode-pages');
  assert.equal(episode.title, '00123 原始節目標題 2024-01-02');
  assert.equal(episode.source.date, '2024-01-02');
  assert.equal(episode.provenance.catalogue_title_basis, 'episode_inventory_title');
  assert.deepEqual(new Set(bodies.map(e => e.source.quality)), new Set([
    'mixed_episode_page_ai_summary_navigation_not_verified_speech',
    'video_introduction_and_comments_not_transcript',
  ]));
  const listings = ctx.entries.filter(e => e.path?.endsWith('/1.txt'));
  assert.ok(listings.every(e => e.category === 'metadata_only' && e.source.type === 'metadata'));
});

test('subtitle admission preserves quarantine and excludes non-subtitle sidecars', async t => {
  const { ctx, put } = await fixture(t);
  for (const group of ['local-asr', 'quarantine']) {
    const base = `collection/transcripts/${group}/sample`;
    await put(`${base}/metadata.json`, JSON.stringify({ id: 'sample', source: 'recording', status: 'machine_unverified' }));
    await put(`${base}/sample.txt`, '字幕原文');
    await put(`${base}/sample.srt`, '1\n00:00:01,000 --> 00:00:02,000\n字幕原文\n');
    await put(`${base}/sample.json`, '{}');
  }
  await machineExtractions(ctx);
  const allowed = ctx.entries.find(e => e.path === 'collection/transcripts/local-asr/sample/sample.srt');
  assert.equal(allowed?.category, 'ready');
  assert.equal(allowed?.source.type, 'transcript');
  const blocked = ctx.entries.find(e => e.path === 'collection/transcripts/quarantine/sample/sample.srt');
  assert.equal(blocked?.category, 'quarantined');
  assert.equal(blocked?.source.status, 'quarantined');
  const sidecar = ctx.entries.find(e => e.path === 'collection/transcripts/local-asr/sample/sample.json');
  assert.equal(sidecar?.category, 'metadata_only');
});

test('failed subtitle collection retains its failure reason', async t => {
  const { ctx, put } = await fixture(t);
  const base = 'collection/transcripts/local-asr/failed';
  await put(`${base}/metadata.json`, JSON.stringify({ id: 'failed', source: 'recording', status: 'download_failed' }));
  await put(`${base}/failed.txt`, '未完成');
  await put(`${base}/failed.srt`, '1\n00:00:01,000 --> 00:00:02,000\n未完成\n');
  await machineExtractions(ctx);
  const subtitle = ctx.entries.find(e => e.path === `${base}/failed.srt`);
  assert.equal(subtitle?.category, 'error');
  assert.equal(subtitle?.reason, 'collection_status:download_failed');
  assert.notEqual(subtitle?.source.status, 'ready');
});
