# Benchmark CLEC on evidence routes

## Reuse the SAG2 controls

SAG2 reuses fixed development subsets of MuSiQue, 2WikiMultiHopQA, and HotpotQA from the HippoRAG 2 release. Each corpus includes labeled supporting passages and distractors. Recall@k measures the average fraction of gold passages retrieved. AllEvidence@k counts questions for which the first k unique results contain every gold passage. EnterpriseRAG-Bench uses source documents instead of passages. The SAG2 paper evaluates retrieval. [Paper](https://arxiv.org/html/2610.22588v1#S4.SS1) · [Dataset adapter](https://github.com/Zleap-AI/SAG-Benchmark/blob/bb7f82751ba1576219f9d9ebd021128603d130c3/sag2/scripts/benchmark_data.py)

Build CLEC cases from natural user situations. Identify the necessary subquestions and search the full corpus for each. Keep independent supporting sources as alternatives. Mark duplicated editions, look-alike episodes, summaries, conflicting versions, and near misses with the wrong condition. Give each alternative a source ID and exact UTF-8 byte spans. A bridge case should fail the evidence check if the fact that connects the two sources is removed. A comparison case can require both sides without demanding a particular order. Use clearly scoped omissions to test insufficient evidence. [MuSiQue case design](https://aclanthology.org/2022.tacl-1.31/) · [2WikiMultiHopQA reasoning paths](https://aclanthology.org/2020.coling-main.580/)

Review and freeze the questions, necessary claims, acceptable evidence alternatives, and budgets before a formal run. Put optional discussion outside the pass criteria. Pool candidate passages from multiple retrieval methods during development and review them without the method name. Record newly accepted evidence routes as label changes. Keep related questions, source editions, and retellings together when allocating the development and held-out sets.

## Replay retrieval

`score_routes.py` scores a necessary evidence obligation when all anchors in at least one alternative route are present. The scorer reuses the Phase 3 checks for source identity, UTF-8 bytes, and verified format equivalents. It reports mean evidence recall and complete evidence counts for the first search, at k = 1, 2, and 5, plus all observed search and read outputs. Failed tool calls remain visible. Unanswerable cases stay in the schedule and have no retrieval coverage score.

Run from the repository root. Use a new output path.

```sh
python3 evaluation/clec-v1/phase3/score_routes.py \
  --data-dir .cache/clec-local-verification/data \
  --labels .audit/sag2-clec-benchmark/adjudicated-labels.json \
  --observations .audit/sag2-clec-benchmark/agent-observations.json \
  --output .audit/sag2-clec-benchmark/agent-recheck.json
```

The labels JSON uses `schemaVersion: 1`, `split`, `corpusSha256`, and `cases`. Each case has `id`, `question`, `category`, `answerable`, and `obligations`. Each obligation has `id`, `kind`, and `routes`. A route is a nonempty array of anchors with `sourceId`, `path`, `quote`, and `spans`. Equivalent but independently authored text needs its own verified anchor. The observations JSON uses `schemaVersion: 1` and cases with matching `id` and `question`. Each step carries `command`, `exitCode`, `stdoutUtf8`, and `stderrUtf8`. Capture native stdout as returned. Keep host events separately to verify the tool output actually reached the model. Include failed calls with empty stdout and omit help output from evidence scoring.

## Run controlled comparisons

1. Compare the same question and snapshot under current lexical search and native SAG2, with the same top-five and byte limits. Separately test an Agent that can follow up within the existing call budget. Capture ranks, delivered and omitted IDs, expansion rounds, provider model identity, candidate judgments, requests, and usage where available. With a provider error, record an execution failure. Use the existing native SAG2 call explicitly and keep credentials in their existing configuration.
2. When results justify a deeper diagnosis, isolate Jev reranking without expansion from one expansion and additional expansion rounds. Match judgment budgets when isolating expansion, and report token and request costs separately. Upstream used this control as well as a no-context ablation. CLEC currently performs at most one expansion, so its production flags do not provide all upstream ablations. [SAG2 controls](https://github.com/Zleap-AI/SAG-Benchmark/blob/bb7f82751ba1576219f9d9ebd021128603d130c3/sag2/README.md#reproduction-notes-and-ablations)
3. Separately score answers using the same model, question, and answer instructions. Record whether each necessary claim is correct, whether the answer preserves its conditions and counterexamples, and whether its actual cited evidence supports it. Check source scope, role, exact quotes, and appropriate abstention. Label omissions as absent from returned evidence or missing from the answer despite being available. Mark unsupported affirmative claims explicitly. A complete citation trail cannot substitute for the reasoning that links the claims.
4. On selected failures, run the answerer with one curator-verified evidence route. If a complete route fixes the answer, investigate retrieval. If it still fails, investigate the answerer and rubric. The curated run is a diagnostic ceiling and stays outside product scores.

The six current cases and the adjudicated labels are development material. The label changes were informed by the recorded outputs. Use a new frozen held-out set to estimate product gains.
