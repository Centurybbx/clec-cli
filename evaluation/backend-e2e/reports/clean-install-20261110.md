# Clean-install CLI portability — 2026-11-10

Outcome: **install and lexical indexing pass; CLI question chain blocked at QMD initialization**. This is one macOS arm64 environment, not a cross-platform portability or retrieval-quality acceptance claim. No mocks, unit/component/legacy tests, GGUF downloads, or test scripts were used. Evidence and the isolated installation remain at `/tmp/clec-clean-install-T6uI1J` for inspection. stdout and stderr are separate files there.

## Setup and identity

Node `/Users/century/.nvm/versions/node/v25.7.0/bin/node` v25.7.0; npm 11.10.1; darwin arm64. Fresh non-checkout deployment `/tmp/clec-clean-install-T6uI1J/backend` copied only package.json, package-lock.json, tsconfig.json and src, without dist or node_modules. Original and copy before and after install/build: package.json SHA-256 `4f86534be5f8014c89d131645c40c9ccac734ee420352eadb6102d5cb28ca6bf`; package-lock.json `6527d08af337325369773fe992c28d1cacd5d845fd01d1bea390560c031ce318`. Manifest and lock specify `git+https://github.com/tobi/qmd.git#86d2365d17fc682e491c2c53d1e4a884aee8682a`. npm warned `skipping integrity check for git dependency ssh://git@github.com/tobi/qmd.git` despite the HTTPS lock; installation succeeded. It also warned about deprecated node-domexception.

With the Node bin directory first on PATH, and DEEPSEEK_API_KEY removed from the environment, executed in the deployment backend:

```sh
npm ci --no-audit --no-fund --fetch-timeout=180000 --fetch-retries=1 --maxsockets=2
npm run typecheck
npm run build
```

The install had an overall 1200-second subprocess timeout and exited 0, adding 266 packages in about one minute; typecheck and build exited 0. No retry was needed. npm-generated QMD build-info was `{"commit":"","builtAt":"2026-11-10T15:21:12.689Z"}`; the timestamp is expected to vary and empty commit is not provenance. Installed QMD index.js `56bda7ce5df22c891af0a7593df617770e2d7ebfb0692b3a3e5c5467b885b049`, store.js `e2bf042216763a6ed122452f4d8f7e33a92bbd50424d2367e8ea44cc37b2bf66`, metadata-filter.js `dacd0d059c69f6060995155a5c11c915ef5519a453106a3a345867b438a1cf8f`, metadata.js `4631366ef27053ff0ec147abe25535ad7888ba577230f7dc7eec9a62f11059d6`: all match frozen runtime fingerprints.

## CLI execution

CLI `/tmp/clec-clean-install-T6uI1J/backend/dist/cli.js`, state `/tmp/clec-clean-install-T6uI1J/state`, copy workspace `/tmp/clec-clean-install-T6uI1J/workspace`, QMD URL `http://localhost:52473`. No key was in catalogue, build, status, source or QMD environments. The isolated workspace-only catalogue reported zero ready sources because it lacked corpus metadata. As in `prepare.ts`, ran the actual CLI catalogue read-only against `/Users/century/vibing/clec`, writing the full intake and report to isolated state, selected its ready `collection/web/clectw/transcripts/short-00400.txt` entry, and copied that genuine source into the isolated workspace. Original and copy SHA-256 both `539682ea9a594c4e8860b68bf4c23e6943b332f24de4ea842ff2e8c834aadada`. No gold text was added to the question.

With the above environment, ran:

```sh
node "$CLI" catalogue --root "$ORIGINAL_ROOT" --manifest "$STATE/full-intake.json" --report "$STATE/full-catalogue.json"
node "$CLI" build "$STATE/selected-intake.json" --lexical
node "$CLI" status
node "$CLI" qmd-serve 52473
node "$CLI" ask '00400 如何调整 2013 年的价格以比较拆股后的图？'
node "$CLI" source 6be096e5ef41b241c6345fd5c784a4291fc3964f40997388a19e0cb804173a77
```

The ask alone received the privately read key in its environment; it was not printed, persisted, or passed as an argument. Lexical build and status exited 0: generation `cc559e6d695c36f452cbf2c317b699d4fc16b80421193fc9fc768336f2ba0013`, one source and one section, QMD 2.8.3 with the explicit source pin above, `embed: null`. QMD announced listening at `/mcp` on the isolated loopback port. Status reports no local model hashes. The source command exited 0 and its complete original string equals the original file exactly. Source ID is shown in the command; version `9836443e8aa92686daf68beb7818f7b681b6cadd6cd9e4a159260e2f236d0e66` and content hash above.

Both the initial ask and one identical retry exited 1, emitting `SEARCH_UNAVAILABLE: QMD compatible generation metadata is unavailable within the bounded check.` QMD logged successful initialize requests but no status calls. A separate read-only diagnostic POST using the same initialize request and Accept header returned HTTP 200 with `Content-Type: text/event-stream` and an `event: message` / `data: { ... }` body. The installed CLEC generation check calls `JSON.parse` on the response body, so this observed protocol mismatch explains the failure. The QMD startup log nevertheless says `responseMode: 'json' drops mid-call notifications`. The runtime cause of QMD returning SSE needs product-side investigation; no product fix was made here.

Candidate count, evidence reads, model calls, answer and citations: **not reached**, not zero-hit or citation success. No provider call was reached in either attempt. For later reconciliation only, the real source contains `2013 年的股價應該也要除以 5` at original UTF-16 offsets `[934, 951)`; this is not an emitted citation and no citation span can be reconciled for the failed runs. The source is labelled an unverified automatic transcript. Raw outputs, including separate ask stderr, are retained in the temporary directory.

## Preservation and next action

Before and after, every one of the 236 files in the frozen inventory matched its recorded hash; the inventory identity is `2c7d9f70cb5f0d110ef69ffcd40c8c00f1fb40f95a272602b2fe8114d4a9324e`. The isolated QMD process was stopped, and its files remain for diagnosis. No shared dependency install or build occurred. Smallest next action: have the product owner investigate and correct the QMD MCP JSON/SSE response contract, then repeat the real CLI ask and citation reconciliation against a newly frozen artifact. The failed run does not establish end-to-end portability.
