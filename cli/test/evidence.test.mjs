import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "../dist/publish.js";
import { Corpus } from "../dist/corpus.js";
import { sync, openCurrent } from "../dist/releases.js";
import { hash, parseManifest } from "../dist/contracts.js";
import { rank } from "../dist/retrieval.js";
import { CURRENT_SCHEMA } from "../dist/corpus-format.js";
import { indexTokens } from "../dist/lexical.js";
import { extract } from "../dist/source-extraction.js";

test("subtitles retain exact UTF-16 positions, overlaps, identifiers and diagnostics", () => {
  const text =
    "\ufeffWEBVTT\r\n\r\nNOTE ignored\r\n00:00.000 --> 00:01.000\r\nnot a cue\r\n\r\nid\r\n00:01.000 --> 00:03.000 position:10%\r\n<b>退休😀</b>\r\n第二行\r\n\r\nid\r\n00:02.000 --> 00:04.000\r\n重疊\r\n\r\n00:99.000 --> 00:01.000\r\n錯誤\r\n";
  const result = extract(Buffer.from(text), true);
  assert.equal(result.text, text);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].originalIdentifier, "id");
  assert.equal(
    text.slice(result.cues[0].textStart, result.cues[0].textEnd),
    "<b>退休😀</b>\r\n第二行",
  );
  assert.equal(result.cues[1].startMs, 2000);
  assert.ok(result.diagnostics.length);
  assert.equal(
    extract(Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n\n"), true).cues
      .length,
    0,
  );
  const utf16 = Buffer.concat([
    Buffer.from([255, 254]),
    Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n中文", "utf16le"),
  ]);
  assert.throws(() => extract(utf16, true), /encoding/);
  const missingSeparator =
    "1\n00:00:01,000 --> 00:00:02,000\n第一句\n2\n00:00:02,000 --> 00:00:03,000\n第二句\n";
  const separated = extract(Buffer.from(missingSeparator), true);
  assert.equal(separated.cues.length, 2);
  assert.equal(separated.cues[1].originalIdentifier, "2");
  assert.equal(
    missingSeparator.slice(
      separated.cues[0].textStart,
      separated.cues[0].textEnd,
    ),
    "第一句",
  );
  assert.match(separated.diagnostics.join(" "), /separator/);
  const noIdentifiers =
    "00:00.000 --> 00:01.000\n甲\n00:01.000 --> 00:02.000\n乙";
  const recovered = extract(Buffer.from(noIdentifiers), true);
  assert.equal(recovered.cues.length, 2);
  assert.equal(recovered.cues[1].originalIdentifier, null);
  assert.equal(
    noIdentifiers.slice(recovered.cues[0].textStart, recovered.cues[0].textEnd),
    "甲",
  );
});

test("BM25 publication retains subtitle evidence, coverage, exact reads and sync rollback", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clec-evidence-"));
  try {
    const workspace = join(temporary, "sources");
    await mkdir(workspace);
    const originals = {
      "episode.srt": "1\r\n00:00:01,000 --> 00:00:03,000\r\n<b>退休😀條件</b>\r\n\r\n2\r\n00:99.000 --> 00:01.000\r\n錯誤\r\n",
      "legacy.str": "1\n00:00:00,000 --> 00:00:01,000\n退休版本\n",
      "episode.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\n退休現金\n",
      "comments.md": "# 退休\n\n介紹及評論並非逐字講述。\n",
      "empty.txt": "  ",
      "bad.srt": "no timing cues",
      "quarantine.md": "退休不應收錄",
      "audio.mp3": "not extracted",
    };
    for (const [path, text] of Object.entries(originals)) await writeFile(join(workspace, path), text);
    const intake = join(temporary, "intake.json");
    await writeFile(intake, JSON.stringify({ schemaVersion: 1, sources: Object.keys(originals).map(path => ({
      path, title: path, type: path.endsWith(".md") ? "document" : "transcript",
      quality: path === "comments.md" ? "introduction_and_comments" : "unverified-transcript",
      status: path === "quarantine.md" ? "quarantined" : "ready",
    })) }));
    const release = join(temporary, "release");
    const manifest = await build({ workspace, intake, output: release });
    assert.equal(manifest.formatRevision, 3);
    assert.deepEqual(manifest.counts, { sources: 4, sections: 4, inventory: 8 });
    const data = join(temporary, "data");
    const activated = await sync(data, join(release, "manifest.json"));
    assert.equal(activated.release, manifest.sha256);
    assert.equal((await sync(data)).reused, true);
    const corpus = await openCurrent(data);
    try {
      const coverage = corpus.coverage();
      assert.equal(coverage.unknownDates, 4);
      assert.equal(coverage.extractionDiagnostics.sources, 1);
      assert.ok(coverage.inventory.some(row => row.status === "quarantined"));
      assert.ok(coverage.inventory.some(row => row.status === "unsupported"));
      const options = { match: "any", perSource: 2, limit: 50, offset: 0 };
      const hits = await corpus.search("退休", options);
      assert.equal(hits.hits.length, 4);
      assert.equal("mode" in hits, false);
      assert.equal((await corpus.search("退休", { ...options, dateFrom: "2020-01-01" })).hits.length, 0);
      const subtitle = hits.hits.find(hit => hit.source.path === "episode.srt");
      assert.ok(subtitle);
      const evidence = corpus.read(subtitle.section.id, 1);
      assert.equal(evidence.text, originals["episode.srt"]);
      assert.equal(evidence.cues[0].startMs, 1000);
      assert.equal(evidence.cues[0].timeBasis, "subtitle-file");
      assert.ok(evidence.metadata.diagnostics.length);
      const found = corpus.find("退休😀", { limit: 20, offset: 0 });
      assert.equal(found.hits.length, 1);
      const literal = found.hits[0];
      assert.equal(corpus.readRange(evidence.source.id, literal.start, literal.end).text, "退休😀");
      assert.throws(() => corpus.readRange(evidence.source.id, literal.start, literal.end - 1), /surrogate/);
      assert.equal(corpus.read(hits.hits.find(hit => hit.source.path === "comments.md").section.id).metadata.role, "introduction-and-comments");
    } finally { await corpus.close(); }
    const invalidDb = join(temporary, "invalid.sqlite");
    await copyFile(join(release, "corpus.sqlite"), invalidDb);
    const changed = new DatabaseSync(invalidDb);
    changed.exec("UPDATE cues SET record=json_set(record,'$.startMs',9999) WHERE source_id=(SELECT source_id FROM cues LIMIT 1)");
    changed.close();
    const badBytes = await readFile(invalidDb);
    const badManifest = { ...manifest, bytes: badBytes.length, sha256: hash(badBytes) };
    const invalidRelease = join(temporary, "invalid-release");
    await mkdir(invalidRelease);
    await copyFile(invalidDb, join(invalidRelease, "corpus.sqlite"));
    await writeFile(join(invalidRelease, "manifest.json"), JSON.stringify(badManifest));
    await assert.rejects(sync(data, join(invalidRelease, "manifest.json")), /Subtitle cues/);
    assert.equal((await readFile(join(data, "current"), "utf8")).trim(), manifest.sha256);
    await writeFile(join(temporary, "mismatch.json"), JSON.stringify({ ...manifest, formatRevision: 1 }));
    await assert.rejects(sync(data, join(temporary, "mismatch.json")), /Manifest format/);
    const rejectedManifest = { ...manifest, formatRevision: 2 };
    await writeFile(join(temporary, "trial.json"), JSON.stringify(rejectedManifest));
    await assert.rejects(sync(data, join(temporary, "trial.json")), /trial format 2/);
    assert.equal((await sync(data)).reused, true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("format 1 remains searchable and format 2 fails explicitly", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clec-formats-"));
  try {
    const workspace = join(temporary, "sources");
    await mkdir(workspace);
    await writeFile(join(workspace, "legacy.md"), "退休原文\n");
    const intake = join(temporary, "intake.json");
    await writeFile(intake, JSON.stringify({ schemaVersion: 1, sources: [{ path: "legacy.md", title: "退休", type: "document", quality: "fixture", status: "ready" }] }));
    const release = join(temporary, "release");
    const built = await build({ workspace, intake, output: release });
    const path = join(release, "corpus.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE cues; DROP TABLE source_metadata; UPDATE metadata SET value='1' WHERE key='formatRevision'");
    legacy.close();
    const bytes = await readFile(path);
    const manifest = { ...built, formatRevision: 1, bytes: bytes.length, sha256: hash(bytes) };
    await writeFile(join(release, "manifest.json"), JSON.stringify(manifest));
    const data = join(temporary, "data");
    await sync(data, join(release, "manifest.json"));
    const corpus = await openCurrent(data);
    try {
      const hits = await corpus.search("退休", { match: "all", perSource: 2, limit: 8, offset: 0 });
      assert.equal(hits.hits.length, 1);
      assert.equal(corpus.read(hits.hits[0].section.id).text, "退休原文\n");
      assert.equal(corpus.coverage().extractionDiagnostics, null);
    } finally { await corpus.close(); }
    const trial = new DatabaseSync(path);
    trial.exec("UPDATE metadata SET value='2' WHERE key='formatRevision'");
    trial.close();
    assert.throws(() => new Corpus(path, manifest.sha256), /trial format 2/);
    assert.throws(() => parseManifest({ ...manifest, formatRevision: 2 }), /trial format 2/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("BM25 caps each source across all matches before paging, including matches after rank 100", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(CURRENT_SCHEMA);
    const addSource = db.prepare("INSERT INTO sources VALUES(?,?,?,?)");
    const addSection = db.prepare("INSERT INTO sections VALUES(?,?,?,?,?,?)");
    const addSearch = db.prepare("INSERT INTO search(rowid,title,tokens) VALUES(?,?,?)");
    addSource.run("many", "v", JSON.stringify({ date: "2026-01-01" }), "retirement");
    for (let i = 0; i < 105; i++) {
      const result = addSection.run(String(i).padStart(3, "0"), "many", i, 0, 10, "whole");
      addSearch.run(result.lastInsertRowid, indexTokens("retirement"), indexTokens("cash"));
    }
    addSource.run("other", "v", JSON.stringify({ date: "2020-01-01" }), "cash");
    const other = addSection.run("other", "other", 0, 0, 4, "whole");
    addSearch.run(other.lastInsertRowid, indexTokens("cash"), indexTokens("retirement"));
    const options = { match: "any", perSource: 2, limit: 8, offset: 0 };
    const ranked = rank(db, "retirement", options);
    assert.equal(ranked.candidates.length, 3);
    assert.deepEqual(ranked.candidates.map(c => c.id), ["000", "001", "other"]);
    assert.equal(ranked.more, false);
    const first = rank(db, "retirement", { ...options, limit: 2 });
    assert.deepEqual(first.candidates.map(c => c.id), ["000", "001"]);
    assert.equal(first.more, true);
    const next = rank(db, "retirement", { ...options, limit: 2, offset: 2 });
    assert.equal(next.candidates[0].id, "other");
    assert.equal(next.more, false);
    assert.ok(ranked.candidates[0].score < ranked.candidates[2].score);
    const filtered = rank(db, "retirement", { ...options, source: "other" });
    assert.equal(filtered.candidates.length, 1);
    assert.equal(filtered.candidates[0].id, "other");
    assert.equal(rank(db, "retirement", { ...options, dateTo: "2021-01-01" }).candidates[0].id, "other");
    assert.equal(rank(db, "retirement missing", { ...options, match: "all" }).candidates.length, 0);
  } finally { db.close(); }
});
