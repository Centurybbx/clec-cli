import { basename } from 'node:path';
import { CatalogueContext, compare, object, quarantined, string } from './context.js';
import type { Candidate, RecordData, RecordReference } from './types.js';

function state(row: RecordData): Pick<Candidate, 'category' | 'reason'> {
  if (quarantined(row.status)) return { category: 'quarantined', reason: 'quarantine_do_not_use' };
  if (row.header_only === true || row.heading_only === true || /^(?:header|heading)[_-]only$/.test(String(row.status))) return { category: 'excluded', reason: 'manifest_marks_header_only' };
  if (row.status === 'ok' || row.status === 'existing' || row.status === 'downloaded' || row.status === 'machine_unverified' || row.status === 'ocr_unverified_incomplete' || row.status === 'published') return {};
  return { category: 'error', reason: `collection_status:${String(row.status ?? 'unknown')}` };
}

export async function localDocuments(ctx: CatalogueContext): Promise<void> {
  for (const name of ['manifest.json', 'spreadsheets-manifest.json']) {
    const file = `collection/text/local/${name}`;
    await ctx.metadata(file, 'local-metadata');
    for (const { data: row, reference } of await ctx.records(file)) {
      if (!ctx.require(row, ['source', 'status'], reference)) continue;
      const original = string(row.source)!;
      const entry = await ctx.add({ family: name.startsWith('spreadsheets') ? 'local-spreadsheets' : 'local-documents', reference, record: row,
        ...state(row), ...(string(row.text) ? { path: string(row.text)! } : {}), title: basename(original), type: 'document',
        quality: name.startsWith('spreadsheets') ? 'spreadsheet_cell_extract_unverified' : 'original_document_text_extract_unverified', origin: original });
      ctx.relate(entry, original, 'extracted_from', 'local extraction manifest source path; no completeness claim');
      await ctx.add({ family: 'local-originals', reference, record: row, path: original, title: basename(original), type: 'document',
        quality: 'original_asset', category: 'unsupported', reason: 'original_asset_requires_extraction_or_uses_separate_extract' });
    }
  }
}

export async function driveDocuments(ctx: CatalogueContext): Promise<void> {
  for (const name of ['text-manifest.json', 'nested-text-manifest.json', 'deep-text-manifest.json']) {
    const file = `collection/sources/drive/${name}`;
    await ctx.metadata(file, 'drive-metadata');
    for (const { data: row, reference } of await ctx.records(file)) {
      if (!ctx.require(row, ['id', 'title', 'status', 'url'], reference)) continue;
      const entry = await ctx.add({ family: 'drive-documents', reference, record: row, ...state(row),
        ...(string(row.path) ? { path: string(row.path)! } : {}), title: string(row.title)!, type: 'document',
        quality: /\.(md|srt|str|txt)$/i.test(string(row.title)!) ? 'drive_text_extract_origin_quality_unverified' : 'original_document_text_extract_unverified', origin: string(row.url)! });
      ctx.relate(entry, string(row.url)!, 'extracted_from', 'Drive text manifest URL; modified/created timestamps are not publication dates');
    }
  }
  const file = 'collection/sources/drive/archive-transcripts-manifest.jsonl';
  await ctx.metadata(file, 'drive-metadata');
  for (const { data: row, reference } of await ctx.records(file)) {
    if (!ctx.require(row, ['id', 'outer_member', 'status', 'archive_source'], reference)) continue;
    if (!Array.isArray(row.files) || !row.files.length) {
      ctx.issue(file, 'invalid_archive_files', 'Expected non-empty files array', reference.record);
      await ctx.add({ family: 'drive-archive', reference, record: row, title: string(row.outer_member)!, type: 'transcript', quality: 'archive_probable_asr_unverified', category: 'error', reason: 'archive_files_absent' });
      continue;
    }
    for (const member of row.files) {
      if (object(member) && member.status === 'unsupported' && !string(member.path)) {
        await ctx.add({ family: 'drive-archive', reference, record: { ...row, member }, title: string(member.original_name) ?? string(row.outer_member)!,
          type: 'transcript', quality: 'archive_member_unverified', category: 'unsupported', reason: 'archive_extractor_unsupported_member' });
        continue;
      }
      if (!object(member) || !ctx.require(member, ['path', 'original_name', 'status', 'sha256'], reference)) {
        ctx.issue(file, 'invalid_archive_member', 'Invalid archive member', reference.record); continue;
      }
      const path = string(member.path)!;
      const entry = await ctx.add({ family: 'drive-archive', reference, record: { ...row, member },
        ...state(row), ...state(member), path, title: string(member.original_name)!, type: 'transcript',
        quality: 'archive_probable_asr_unverified_no_verified_speakers', origin: string(row.archive_source)!, expectedHash: string(member.sha256)! });
      ctx.relate(entry, `${string(row.archive_source)}#${string(row.outer_member)}`, 'representation_of', 'same nested archive member; content equivalence has not been asserted');
    }
  }
}

export async function clectw(ctx: CatalogueContext): Promise<void> {
  const file = 'collection/web/clectw/episode-inventory.jsonl';
  const episodeTitles = new Map<string, string>();
  await ctx.metadata(file, 'clectw-metadata');
  for (const { data: row, reference } of await ctx.records(file)) {
    if (!ctx.require(row, ['url', 'episode_id', 'status', 'transcript_status'], reference)) continue;
    const episodeTitle = string(row.title);
    if (episodeTitle) episodeTitles.set(string(row.url)!, episodeTitle);
    const path = string(row.transcript);
    const entry = await ctx.add({ family: 'clectw-transcripts', reference, record: row,
      ...(path ? { path } : {}), title: string(row.title) ?? string(row.episode_id)!, type: 'transcript',
      quality: 'automatic_transcript_unverified_no_verified_timestamps_or_speakers', origin: string(row.url)!,
      ...state(row), ...(!path ? { category: 'missing' as const, reason: `transcript:${String(row.transcript_status)}` } : {}) });
    ctx.relate(entry, string(row.url)!, 'extracted_from', 'episode inventory transcript path, not mentions_transcript heuristic');
    if (string(row.html)) ctx.relate(entry, string(row.html)!, 'extracted_from', `saved HTML; declared SHA-256 ${String(row.html_sha256 ?? 'unknown')}`);
  }
  await webManifest(ctx, 'clectw', episodeTitles);
  const audit = 'collection/web/clectw/transcript-quality-audit.jsonl';
  await ctx.metadata(audit, 'clectw-metadata');
  for (const { data: row, reference } of await ctx.records(audit)) {
    if (!ctx.require(row, ['file', 'status'], reference)) continue;
    const flagged = quarantined(row.status) || /flagged|review|repetit/i.test(String(row.status)) && row.status !== 'not_flagged_automatically';
    if (flagged) {
      await ctx.add({ family: 'clectw-quality-flags', reference, record: row, path: string(row.file)!, title: basename(string(row.file)!), type: 'transcript',
        quality: 'automatic_transcript_quality_flag_requires_review', category: 'quarantined', reason: 'quality_audit_requires_review' });
    }
  }
}

export async function webManifest(ctx: CatalogueContext, site: 'clec168' | 'cfnavi' | 'clectw', episodeTitles?: ReadonlyMap<string, string>): Promise<void> {
  const file = `collection/web/${site}/manifest.jsonl`;
  await ctx.metadata(file, `${site}-metadata`);
  for (const { data: row, reference } of await ctx.records(file)) {
    if (!ctx.require(row, ['url', 'status'], reference)) continue;
    const url = string(row.url)!;
    let pathname: string;
    try { pathname = new URL(url).pathname; }
    catch { ctx.issue(file, 'invalid_url', url, reference.record); continue; }
    const episodePage = site === 'clectw' && /^\/ep\/[^/]+\/?$/.test(pathname);
    const listing = site === 'clectw' && !episodePage || /\/(?:page|category)(?:\/|$)/.test(pathname) || !/^\/(?:blog|docs|database|video)\/.+/.test(pathname) && site === 'clec168';
    const video = site === 'clec168' && pathname.startsWith('/video/');
    const family = listing ? `${site}-metadata` : episodePage ? 'clectw-mixed-episode-pages' : video ? 'clec168-video-introductions-comments' : site === 'cfnavi' ? 'cfnavi-curated' : 'clec168-body-extracts';
    const episodeTitle = episodePage ? episodeTitles?.get(url) : undefined;
    let title = string(row.title) ?? episodeTitle ?? url;
    if (!string(row.title) && !episodeTitle && !listing && string(row.text)) {
      try {
        const lines = (await ctx.text(string(row.text)!)).split(/\r?\n/).map(line => line.trim())
          .filter(line => line && !/^(?:来源|來源|采集时间|採集時間)\s*[:：]/.test(line) && !/^\[[\w-]+\]$/.test(line));
        const first = lines[0];
        if (first) title = (/^\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}$/.test(first) ? lines.slice(0, 2).join(' ') : first).slice(0, 1000);
      } catch { /* ctx.add below records missing/read/encoding failures against this record. */ }
    }
    const entry = await ctx.add({ family, reference, record: { ...row, catalogue_title_basis: title === url ? 'url_fallback' : string(row.title) ? 'manifest_title' : episodeTitle ? 'episode_inventory_title' : 'saved_body_heading' }, ...(string(row.text) ? { path: string(row.text)! } : {}),
      title, type: listing ? 'metadata' : 'curated',
      quality: episodePage ? 'mixed_episode_page_ai_summary_navigation_not_verified_speech' : video ? 'video_introduction_and_comments_not_transcript' : site === 'cfnavi' ? 'third_party_course_summary_unverified' : 'website_body_extract_unverified_may_include_comments',
      origin: url, ...(listing ? { category: 'metadata_only' as const, reason: 'listing_not_evidence_body' } : {}), ...state(row) });
    ctx.relate(entry, url, 'extracted_from', 'collection web manifest; page body may include comments');
    if (string(row.html)) {
      ctx.relate(entry, string(row.html)!, 'extracted_from', 'saved original HTML path');
      await ctx.add({ family: `${site}-html`, reference, record: row, path: string(row.html)!, title: url, type: 'metadata', quality: 'original_webpage_asset', category: 'metadata_only', reason: 'html_preserved_not_admitted_as_text', origin: url });
    }
  }
}

/** Enumerate only the explicit curated knowledge tree; no other repository content is admitted. */
export async function curatedKnowledge(ctx: CatalogueContext): Promise<void> {
  const base = 'collection/sources/clec-md/knowledge';
  async function visit(dir: string): Promise<void> {
    for (const name of await ctx.names(dir)) {
      const path = `${dir}/${name}`;
      if (await ctx.isDirectory(path)) { await visit(path); continue; }
      if (!name.endsWith('.md')) continue;
      let text: string;
      try { text = await ctx.text(path); }
      catch (error) { ctx.issue(path, 'curated_read_failed', (error as Error).message); text = ''; }
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
      // Preserve full YAML rather than attempting to interpret nested YAML without a parser dependency.
      const title = frontmatter?.match(/^title:\s*([^\r\n]+)$/m)?.[1]?.replace(/^(['"])(.*)\1$/, '$2') ?? basename(path, '.md');
      const declaredDate = frontmatter?.match(/^date:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m)?.[1];
      const declaredStatus = frontmatter?.match(/^status:\s*([^\r\n]+)$/m)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
      const entry = await ctx.add({ family: 'clec-md-knowledge', reference: { file: path, record: 0 }, record: {
        frontmatter: frontmatter ?? null, raw_transcripts: 'absent_from_public_repository', repository: 'https://github.com/fraserlai/clec-md',
        collected_commit: 'e0f088797a74ab70a1761671dda7dc1c94db374f',
        ...(declaredDate ? { date: declaredDate, date_basis: 'third_party_curated_frontmatter' } : {}),
        ...(declaredStatus ? { status: declaredStatus } : {}),
      }, path, title, type: 'curated', quality: 'third_party_ai_curated_interpretation_raw_transcripts_absent', origin: `https://github.com/fraserlai/clec-md/blob/e0f088797a74ab70a1761671dda7dc1c94db374f/knowledge/${path.slice(base.length + 1)}` });
      ctx.relate(entry, 'https://github.com/fraserlai/clec-md', 'extracted_from', 'curated knowledge repository, not primary speech');
    }
  }
  await visit(base);
}

export async function machineExtractions(ctx: CatalogueContext): Promise<void> {
  for (const group of ['local-asr', 'podcast-asr', 'quarantine', 'ocr']) {
    const base = `collection/transcripts/${group}`;
    for (const name of await ctx.names(base)) {
      const dir = `${base}/${name}`;
      if (!await ctx.isDirectory(dir)) continue;
      const file = `${dir}/metadata.json`;
      await ctx.metadata(file, `${group}-metadata`);
      let row: RecordData;
      try {
        const value: unknown = JSON.parse(await ctx.text(file));
        if (!object(value)) throw new Error('Expected metadata object');
        row = value;
      } catch (error) { ctx.issue(file, 'invalid_metadata', (error as Error).message); continue; }
      const reference: RecordReference = { file, record: 1 };
      const id = string(row.id) ?? name;
      if (!ctx.require(row, group === 'ocr' ? ['source', 'status'] : ['id', 'source', 'status'], reference)) continue;
      if (id !== name) ctx.issue(file, 'id_directory_mismatch', `ID ${id} differs from directory ${name}`, 1);
      const origin = string(row.media_url) ?? string(row.video_source) ?? string(row.source)!;
      const files = await ctx.names(dir);
      // TXT pathname is defined by this family's metadata contract, not by arbitrary extension crawling.
      const path = `${dir}/${group === 'ocr' ? 'frames-raw' : id}.txt`;
      const entry = await ctx.add({ family: group, reference, record: row, path, title: string(row.source_title) ?? id,
        type: group === 'ocr' ? 'document' : 'transcript', quality: group === 'ocr' ? 'partial_sampled_frame_ocr_unverified_not_transcript' : 'local_machine_asr_unverified_no_verified_speakers', origin,
        ...state(row), ...(group === 'quarantine' ? { category: 'quarantined' as const, reason: 'quarantine_do_not_use' } : {}) });
      ctx.relate(entry, origin, 'extracted_from', 'metadata media URL and checksum; TXT has no inferred timestamps');
      for (const sibling of files.filter(n => n.startsWith(`${id}.`) && n !== `${id}.txt`).sort(compare)) {
        const subtitle = /\.(srt|str|vtt)$/i.test(sibling);
        await ctx.add({ family: group, reference, record: row, path: `${dir}/${sibling}`, title: sibling,
          type: subtitle ? 'transcript' : 'metadata',
          quality: subtitle ? 'local_machine_subtitle_unverified_no_verified_speakers' : 'machine_output_sidecar_unverified', origin,
          ...(subtitle ? { reason: 'subtitle_requires_publisher_cue_validation', ...state(row) }
            : { category: 'metadata_only' as const, reason: 'machine_output_sidecar' }),
          ...(group === 'quarantine' || quarantined(row.status)
            ? { category: 'quarantined' as const, reason: 'quarantine_do_not_use' } : {}) });
      }
    }
  }
}

export async function metadataInventories(ctx: CatalogueContext): Promise<void> {
  // Explicit metadata directories, shallow listing only. No tools, environments, summaries or source-code trees.
  for (const dir of ['collection/sources/podcast', 'collection/sources/drive', 'collection/web/clec168', 'collection/web/clectw', 'collection/web/cfnavi']) {
    for (const name of await ctx.names(dir)) {
      if (!/\.(json|jsonl|xml|txt)$/.test(name)) continue;
      const file = `${dir}/${name}`;
      if (!ctx.entries.some(e => e.path === file)) await ctx.metadata(file, dir.includes('podcast') ? 'podcast-metadata' : 'collection-metadata');
      if (dir.endsWith('/drive') && name.endsWith('folder-inventory.json')) await driveFolderInventory(ctx, file);
    }
  }
  const file = 'collection/sources/podcast/episode-inventory.jsonl';
  for (const { data: row, reference } of await ctx.records(file)) {
    if (!ctx.require(row, ['title', 'feed'], reference)) continue;
    const entry = await ctx.add({ family: 'podcast-episodes', reference, record: row, title: string(row.title)!, type: 'metadata', quality: 'rss_episode_metadata_not_audio_or_transcript', category: 'metadata_only', reason: 'rss_metadata_only' });
    if (string(row.enclosure_url)) ctx.relate(entry, string(row.enclosure_url)!, 'representation_of', 'RSS enclosure URL; no locally searchable audio assumed');
    if (Array.isArray(row.possible_matches)) for (const match of row.possible_matches) {
      if (object(match) && string(match.url)) ctx.relate(entry, string(match.url)!, 'candidate_match', 'unverified inventory candidate; episode/title match is not equivalence');
    }
  }
  // Known local binary downloads alongside the extraction manifests.
  for (const file of ['collection/sources/drive/transcripts.zip', 'collection/sources/drive/00472-slides.pdf', 'collection/sources/drive/00514-利率運作.docx']) {
    await ctx.add({ family: 'drive-originals', reference: { file, record: 0 }, record: { role: 'original_download' }, path: file, title: basename(file), type: 'document', quality: 'original_download_asset', category: 'unsupported', reason: 'binary_original_not_searchable' });
  }
}

async function driveFolderInventory(ctx: CatalogueContext, file: string): Promise<void> {
  let value: unknown;
  try { value = JSON.parse(await ctx.text(file)); }
  catch (error) { ctx.issue(file, 'invalid_json', (error as Error).message); return; }
  if (!object(value)) { ctx.issue(file, 'invalid_folder_inventory', 'Expected group-keyed object'); return; }
  let index = 0;
  for (const group of Object.keys(value).sort(compare)) {
    const folder = value[group];
    if (!object(folder) || !Array.isArray(folder.files)) { ctx.issue(file, 'invalid_folder_inventory', `Group ${group} lacks files array`); continue; }
    for (const row of folder.files) {
      index += 1;
      if (!object(row) || !ctx.require(row, ['id', 'title', 'mime_type'], { file, record: index })) continue;
      const entry = await ctx.add({ family: 'drive-remote-inventory', reference: { file, record: index }, record: { ...row, inventory_group: group },
        title: string(row.title)!, type: 'metadata', quality: 'remote_listing_access_not_verified', category: 'metadata_only',
        reason: row.file_or_folder === 'folder' ? 'remote_folder_listing' : 'remote_asset_listing_not_local_content' });
      if (string(row.url)) ctx.relate(entry, string(row.url)!, 'representation_of', 'remote inventory entry, not a downloaded/extracted content assertion');
    }
  }
}
