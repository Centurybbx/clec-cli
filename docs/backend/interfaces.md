# Verified dependency interfaces (2026-11-10)

Pinned registry versions: `@earendil-works/pi-coding-agent` 1.5.2, `@earendil-works/pi-ai` 1.5.2, `@tobilu/qmd` 2.8.3. Node on this machine: 25.7.0; Pi requires >=22.19.0, QMD >=22.0.0. Native package installation and GGUF model availability remain distinct from TypeScript compilation and E2E acceptance.

The get-api-docs skill was applied: `chub --help`, searches for Pi/QMD (no matching entry), and `chub get deepseek/llm --lang js`. Chub's DeepSeek entry predates the current named models; official current docs and installed provider declarations take precedence.

## Pi

Official [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [full-control example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts), and published 1.5.2 `sdk.d.ts`, `resource-loader.d.ts`, `model-runtime.d.ts`, `agent-session.d.ts`, `extensions/types.d.ts` were inspected.

- Factory: `createAgentSession` with explicit `ModelRuntime`, `ResourceLoader`, `SessionManager`, `SettingsManager`, and custom tool allowlist. Modern tools option is names, not built-in tool objects.
- `ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath:null, refreshOnCreate:false, allowModelNetwork:false})` avoids user credential/config discovery. Runtime key set explicitly from DEEPSEEK_API_KEY; no OAuth/subscription or unrelated environment provider fallback.
- `session.prompt()` resolves after run; `agent_settled` distinguishes recovery/queues from low-level `agent_end`. `abort()` awaits idle; `dispose()` tears down listeners/runtime resources. Text is buffered and validated before release.
- Restore must use SessionManager; direct agent.state assignment is forbidden. Current CLI uses in-memory SessionManager, with no restoration promise.
- Pi's public `agent.streamFunction` is wrapped to enforce request/output/context budgets. Cache warming, compaction, retries, install telemetry and analytics disabled; no hidden summarization/model warming calls.

### QA diagnostic hooks — installed public evidence, 2026-11-11

`pi-ai/dist/types.d.ts` exposes `StreamOptions.onResponse(response, model)` and `onProviderStreamEvent(event, model)`; `SimpleStreamOptions` inherits them. The installed public `dist/api/openai-completions.js` calls onResponse before consuming the body and onProviderStreamEvent for parsed chunks before normalization. `qa/provider-observation.ts` preserves prior callbacks, records no arguments/content and observes only the first provider event per admitted request. `message_end` supplies the separately labeled normalized stream end/abort boundary; waitForIdle supplies local settlement. Admission, HTTP response, provider event, abort request and local settlement have distinct meanings. None proves ongoing remote work, remote cancellation, complete usage or billing. Terra must verify real hook invocation and races.

The get-api-docs skill was reapplied (`chub --help`, `chub search "pi-ai" --json`: no match); exact pinned SDK declarations and adapter code supply the hook evidence. No new dependency or provider feature was added.

## DeepSeek

Official [API introduction](https://api-docs.deepseek.com/), [tool calls](https://api-docs.deepseek.com/guides/tool_calls/), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/), and [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/) were checked. Installed Pi 1.5.2 provider catalog includes deepseek-flash and deepseek-v4-pro, with `thinkingFormat:deepseek`, `max_tokens`, no developer role/store, and reasoning-content replay support. Thinking mode is deliberately disabled for this milestone via `thinkingLevel:off` and explicit `thinking:{type:'disabled'}` payload override. No OpenAI reasoning-effort mapping is sent. Actual tool calls use streamed Chat Completions; host-prefetched evidence is normal user context because the Chat Completion API does not permit synthetic mid-history tool-call insertion.

Default model `deepseek-flash`, base `https://api.deepseek.com`; DEEPSEEK_MODEL and DEEPSEEK_BASE_URL override explicitly. Known model overrides preserve their own catalog limits/cost; unknown model IDs inherit Flash-compatible protocol settings with cost availability marked false. Compatibility of unknown IDs requires Terra live validation. Catalog cost is only an estimate, not billed cost. Parent reports credentials securely supplied to Terra; this worker did not read them or make live requests.

## QMD

Official [README](https://github.com/tobi/qmd), installed 2.8.3 `dist/index.d.ts`, `dist/mcp/server.js`, and CLI/configuration implementation were inspected. Only public SDK and HTTP/CLI surfaces are called.

- Index: `createStore({dbPath,configPath})`, `update({collections})`, optional `embed({})`, `close()`.
- Persistent query server: public `qmd mcp --http --host localhost --port 8181`, with isolated `INDEX_PATH` and `QMD_CONFIG_DIR` configuration. No per-question subprocess.
- `POST /query`: `{searches:[{type:'lex'|'vec',query}],collections:[generationCollection],limit,candidateLimit,rerank}`; response `{results:[{file:'qmd://collection/path',score,...}]}`. AbortSignal is passed to fetch. Client disconnect does not prove server GPU work stops.
- **Version gap:** main README documents metadata filters; published 2.8.3 HTTP and SDK do not forward them. Source/type filters are currently host-side after top40 and can lose recall. Date filters and recall-preserving constrained retrieval are next-slice work. Do not silently send ignored filter fields.
- Search normalization is one NFKC simplified-Chinese copy. Original/traditional/simplified query aliases preserve original query; source text remains exclusively original in evidence reads. QMD 2.8.3 implements CJK character tokenization internally. Lexical default does not promise paraphrase recall. Hybrid mode requires embeddings and local model downloads/provisioning; Qwen3 multilingual embedding option documented upstream.
