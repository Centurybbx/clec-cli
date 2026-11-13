# Portable CLI implementation report

The intended product is a small local evidence tool for agents. The publisher prepares data once; consumers download it and run search, read and source commands. The external agent owns reasoning and answer composition. This round implements and verifies that path. It does not publish a public release or retire every older capability.

## Delivered

`cli/` contains an independent TypeScript package. Its consumer installation requires Node and OpenCC, with no Pi, QMD, model, API key, HTTP service or MCP server. Publisher code is excluded from the consumer tarball. The publisher builds one SQLite file directly from intake. That file contains exact originals, sections, inventory and lexical indexes.

Commands are `sync`, `search`, `read`, `source` and `status`. They emit JSON. Search supports traditional/simplified normalization, optional all-term matching, source filtering and date filtering. Reads return exact source spans and neighboring references. Checksummed updates activate only after validation; unavailable old references fail explicitly.

The [usage guide](../README.md) and [format/architecture contract](portable-cli.md) describe installation and the publisher workflow. There is no configured Git remote or public artifact endpoint, so the examples intentionally use local paths.

## Measured storage and construction

| Item | Logical bytes | Interpretation |
|---|---:|---|
| Final CLI tarball | 10,729 | Does not bundle its npm dependency or Node |
| Installed consumer production modules | 5,685,088 | CLI plus its production dependency |
| Full SQLite data file | 527,507,456 | Approximately 503 MiB, including originals and index |
| Active consumer data directory | 527,507,521 | Database plus current pointer |
| Publisher peak observed at one-second intervals | 810,221,524 | Sampled lower bound, not an exact peak |
| Same-size full update data budget | 1,055,014,912 | Calculated current plus incoming file, not a measured full-to-full update |
| This complete development/verification run | 1,272,068,165 | Includes publisher and consumer data copies, private Node verification runtime, dependencies and logs |

The one complete publisher build took 86.66 seconds on this machine. This is a single observation with successful complete output, not an engine benchmark or a speedup ratio against the former vector build. Actual HTTP update testing went from the small real sample to the full dataset; its observed managed-directory peak was 527,712,415 bytes at 0.25-second intervals.

The consumer caps a single artifact at 2 GiB and requires incoming-file space plus a 5 GiB reserve. Repeated same-version sync verifies and reuses local data. Managed stale-file cleanup runs before further growth. Original assets and historical canonical indexes are outside the consumer directory and are not deleted by sync.

## Verification

Real packed-install tests ran on macOS arm64 with Node 22.19.0 and 25.7.0. Every one of the 6,775 source records, versions, original contents and hashes matched the canonical database. All 30,565 section identities, ordinals, offsets and boundaries matched. The package also retains 17,972 intake inventory entries. This establishes indexed-text parity, not independent verification of unsupported binary assets.

Tests passed for fresh installation, exact reads, source paging, bounded inputs, source/date filters, traditional/simplified queries, a single Han character, and actual AND versus OR behavior. Relocated installation and data worked with network and producer paths denied. Real HTTP tests covered checksum mismatch, interrupted transfer, successful update, repeat sync without another data transfer, cross-directory manifest redirects and explicit artifact URLs for signed-style redirects. An old sample reference failed after activation of the full release.

Independent static review found no blocking production defect. A forced publisher termination can leave staging requiring manual inspection and recovery. Windows and Linux were not tested. No claim of power-loss durability follows from these tests.

## Retrieval and answer limitations

The 45 development questions exposed both real retrieval misses and evaluation defects. The evaluator originally used the expected source to decide neighbor reads and normalized CRLF; both issues were corrected and the observations rerun. Exact annotated-path coverage still rejects some useful alternative transcript copies. Independent review confirmed relevant alternative evidence for three inspected cases, while other cases remained unresolved or ambiguous. These observations are not a corpus-wide recall estimate.

A fresh agent then used the frozen installed package on twelve question-only held-out cases, without seeing expected answers. A separate reviewer graded actual reads and frozen answers. Content results were **8 PASS, 3 PARTIAL and 1 FAIL**. The partial answers omitted a date, a comparison caveat or an applicable condition. The failed retrieval abstained instead of inventing the requested document contents.

This was one agent, one dataset and a small related question set. One question used four searches despite a planned cap of three; it did not succeed. The saved batch does not prove the prescribed sequential two-turn procedure, so that procedure is inconclusive. The results must not be presented as universal accuracy or full compliance with the search budget. No tuning followed exposure to the held-out grading.

## What remains

The new install package already excludes the old service stack. Old backend code and its data remain available because complete replacement quality has not passed. The Python tool also retains webpage-introduction/comment search and subtitle timing that this package has not migrated. Deleting it now would lose those capabilities. Original data and old indexes were not removed in this round.

Public distribution still needs a real repository/release destination and uploaded CLI/data artifacts. Source-selection coverage, answer-condition preservation and difficult retrieval remain explicit work, not hidden promises. The architecture does not require restoring a built-in answering agent or a local model server to address them.

## Evidence

Reproducible scripts are in `evaluation/portable-cli/`. Local detailed reports are [runtime verification](../.audit/cli-20261113/verification-runtime.md), [artifact check](../.audit/cli-20261113/artifact-check.md), [independent code review](../.audit/cli-20261113/final-code-review.md), [blind grading](../.audit/cli-20261113/blind-verdict.md), and [decision trail](../.audit/cli-20261113/decisions.tsv). These `.audit` artifacts are local and are not included in the consumer package.

Model the Domain shaped the separation of immutable evidence from release installation. Laziness Protocol removed models, answering sessions and duplicate passage storage from the successor package. Prove It Works required real packed installs and complete evidence comparisons before making capability claims.

## Attention

reviewed by gpt-6.1-sol

The trail audit found no invented decision. Keep unpublished distribution, deferred retirement, blind-test protocol limits and indexed-text parity boundaries explicit. Full-to-full update space is calculated, not the measured sample-to-full transfer peak. Initial trail timestamps are approximate; appended audit rows clarify their provenance, resolve weak evidence pointers and record the evaluator correction. See the local [trail review](../.audit/cli-20261113/trail-review.md).
