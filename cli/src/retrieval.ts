import type { DatabaseSync } from "node:sqlite";
import { queryTokens } from "./lexical.js";
import type { SearchOptions } from "./corpus.js";

export function rank(
  db: DatabaseSync,
  query: string,
  options: SearchOptions,
): { candidates: { id: string; score: number }[]; more: boolean } {
  const tokens = queryTokens(query);
  // Materialization computes BM25 within the FTS relation before window ranking.
  const rows = db.prepare(
    `WITH scored AS MATERIALIZED (
      SELECT s.id,s.source_id,bm25(search,4.0,1.0) score
      FROM search JOIN sections s ON s.rowid=search.rowid
      JOIN sources o ON o.id=s.source_id
      WHERE search MATCH ? AND (? IS NULL OR s.source_id=?)
        AND (? IS NULL OR json_extract(o.record,'$.date')>=?)
        AND (? IS NULL OR json_extract(o.record,'$.date')<=?)
    ), ranked AS (
      SELECT *,row_number() OVER (PARTITION BY source_id ORDER BY score,id) source_rank FROM scored
    ) SELECT id,score FROM ranked WHERE source_rank<=? ORDER BY score,id LIMIT ? OFFSET ?`,
  ).all(
    tokens.map((token) => `"${token}"`).join(options.match === "all" ? " AND " : " OR "),
    options.source ?? null,
    options.source ?? null,
    options.dateFrom ?? null,
    options.dateFrom ?? null,
    options.dateTo ?? null,
    options.dateTo ?? null,
    options.perSource,
    options.limit + 1,
    options.offset,
  );
  return {
    candidates: rows.slice(0, options.limit).map((row) => ({ id: String(row.id), score: Number(row.score) })),
    more: rows.length > options.limit,
  };
}
