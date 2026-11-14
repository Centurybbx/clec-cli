# Research with CLEC

Start with `clec --help`, `clec status --format json`, and `clec coverage --format json`. Run `clec guide research` to rediscover this guide. Obtain a publisher manifest when no corpus is installed.

1. Break the question into claims, conditions, dates, named instruments, and possible counterexamples. For a named episode, run `clec sources 'identifier or title' --format json`. Preserve episode identifiers when changing queries.
2. Conduct an initial query round, a concept and paraphrase round, a counterevidence round, and a time or version round. Follow referrals and neighboring episode identifiers in a further query round. Run several BM25 searches. Translate concepts and paraphrases into alternative literal terms, names, and opposite claims. `--match all` requires all query tokens; it does not perform phrase matching.
3. Read candidate sections before using them. Run `clec read REF REF --context 1 --format json`. Read the full question and answer when attribution depends on their boundary. Inspect neighboring sections for conditions, the questioner's situation, the reply, and exceptions. Search previews are navigation aids.
4. Follow incomplete context with `clec source SOURCE_REF`, more section reads, and `clec find 'exact wording' --source SOURCE_REF`. Use returned offsets with `read-range` for a precise original interval. Read results use UTF-16 offsets.
5. Check source role and quality. Introductions, comments, and AI summaries do not establish a teacher's exact statement. Unverified transcripts do not establish a speaker without contextual evidence. A subtitle cue's time belongs to its subtitle file. It is not a verified seek target. Cite exact original text.
6. Compare editions, dates, and conditions. Describe disagreements directly. Keep retirement cases separate from accumulation cases, percentages separate from balances, and proposed allocations separate from actual holdings. Multiple sources about one episode may repeat the same evidence. Count the event once rather than treating duplicate pages as votes. Do not invent an explanation for a position changing over time.
7. Track what you read and what remains unread. Search pages through matching sections after the per-source cap. A null `nextOffset`, zero lexical hits, or a date-filtered result never proves that relevant evidence is absent. Inspect coverage exclusions and unknown dates when describing gaps.
8. Answer each claim from text actually read. Preserve source title, date basis, section reference, qualifications, and numerical units. Distinguish quotations, paraphrases, and inferences. Report unresolved counterevidence, transcription uncertainty, and missing material.

Repeat identical search options with the returned release and `page.nextOffset` to page through these capped matches. A stale-reference error requires fresh discovery. Batch reads preserve order and duplicates and fail without partial stdout.

Stop when the claims and their conditions have been checked against actual reads and counterevidence, or when you can state the unresolved gaps. Report known unread sources and why those gaps remain.

The host agent owns query planning, follow-up, claim tracking, and synthesis. The CLI returns evidence and explicit coverage limits. The CLI does not decide that research is complete.
