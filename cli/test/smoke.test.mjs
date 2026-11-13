import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('installed workflow preserves evidence and recovers from failures', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'clec-smoke-'));
  const data = join(temporary, 'data');
  const workspace = join(temporary, 'sources');
  const release = join(temporary, 'release');
  const executable = resolve('dist/cli.js');
  const run = (args, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', executable, '--data-dir', data, '--format', 'json', ...args], {
    encoding: 'utf8', input, timeout: 30_000, maxBuffer: 2 * 1024 ** 2,
  });
  const success = (args, input) => {
    const result = run(args, input);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.ok, true);
    return envelope.data;
  };
  try {
    assert.equal(success(['status']).ready, false);
    for (const command of ['search', 'sources', 'source', 'read', 'sync', 'status']) success([command, '--help']);
    success(['--version']);
    const invalid = run(['search', 'test', '--unknown']);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /INVALID_ARGUMENT/);

    mkdirSync(workspace);
    const originals = {
      'first.md': '# 退休提款\n\n這是一份專門用於 CLI 測試的文件。退休提款須保留年度及適用條件。\n',
      'second.md': '# 退休條件\n\n這也是測試文件。退休方案的條件不同，不應當混為同一個版本。\n',
    };
    for (const [path, text] of Object.entries(originals)) writeFileSync(join(workspace, path), text);
    const intake = join(temporary, 'intake.json');
    writeFileSync(intake, JSON.stringify({ schemaVersion: 1, sources: Object.keys(originals).map((path, index) => ({
      path, title: index ? '退休條件' : '退休提款', type: 'document', quality: 'Authored CLI test fixture', status: 'ready',
      date: '2026-01-01', dateBasis: 'Test fixture date',
    })) }));
    const built = spawnSync(process.execPath, [resolve('dist/publisher.js'), '--workspace', workspace, '--intake', intake, '--output', release], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const synced = success(['sync', '--manifest', join(release, 'manifest.json')]);
    assert.equal(success(['status']).ready, true);
    assert.equal(success(['sync']).reused, true);
    const hits = success(['search', '退休', '--limit', '1']);
    assert.equal(hits.hits.length, 1);
    assert.equal(hits.page.nextOffset, 1);
    const second = success(['search', '退休', '--limit', '1', '--offset', '1', '--release', hits.release]);
    assert.notEqual(second.hits[0].ref, hits.hits[0].ref);
    const found = success(['sources', '退休提款']);
    assert.equal(found.items.length, 1);
    const read = success(['read', '--stdin', '--context', '0'], hits.hits[0].ref + '\n');
    assert.equal(read.items.length, 1);
    const evidence = read.items[0];
    assert.equal(evidence.text, originals[evidence.source.path].slice(evidence.section.start, evidence.section.end));
    const failedBatch = run(['read', '--stdin'], hits.hits[0].ref + '\ninvalid\n');
    assert.equal(failedBatch.status, 2);
    assert.equal(failedBatch.stdout, '');
    const failedSync = run(['sync', '--manifest', join(temporary, 'missing.json')]);
    assert.notEqual(failedSync.status, 0);
    assert.equal(success(['status']).release, synced.release);
    assert.equal(success(['sync']).reused, true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
