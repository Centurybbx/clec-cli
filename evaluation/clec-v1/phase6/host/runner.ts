import { pinAttemptCorpus, readPublicCorpus, retainCorpus } from "./contract/corpus.ts";
import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readEvidence } from "./validate/artifacts.ts";
import { anchorFor, type AttemptIdentity, type ExpectedCommitments, parsePlan, PROOF_MODEL, publicProfile, systemPreamble } from "./contract.ts";
import { runAttempt } from "./runner/attempt.ts";
import { startSyntheticLoopback, type MockOpenAIAction } from "./runner/loopback.ts";
import { createExclusiveDir, parseRawJson, publishExclusiveIndex, writeExclusiveFile } from "./capture/framing.ts";
import { captureExecutionClosure, sha256Buffer } from "./capture/pins.ts";
import { makeRunId, HOST_LIMITS } from "./contract/types.ts";
import { equal, inspectRun, PiProjection, reconcile, requireFact, runtimeWitness, snapshotArtifacts, summaryEnvelope, type Validation } from "./validate.ts";

type Prefix = Extract<Validation, { kind: "Incomplete" }>;
type LoopbackFixture = (attempt: AttemptIdentity, seq: number) => MockOpenAIAction;

export async function sealRun(root: string, expected: ExpectedCommitments): Promise<Validation> {
	const result = reconcile(root, expected, "Closed");
	if (result.kind !== "Complete") return result;
	try {
		if (lstatSync(join(root, "summary.json"), { throwIfNoEntry: false })) {
			return inspectRun(root, expected);
		}
		await publishExclusiveIndex(join(root, "summary.json"), JSON.stringify(summaryEnvelope(result.summary), null, 2));
		return result;
	} catch (err) {
		return { kind: "Invalid", invariant: err instanceof Error ? err.message : String(err) };
	}
}

export { inspectRun };

// The synthetic fixture is injected at the server boundary. It cannot change
// the Pi runtime, native invocation, evidence files, tool permissions or schedule.
export async function collectRun(input: unknown, evidenceParent: string, publicCorpusDir: string, fixture: LoopbackFixture) {
	const closure = captureExecutionClosure();
	const corpus = readPublicCorpus(publicCorpusDir);
	const skill = readFileSync(closure.skillPin.canonicalPath);
	equal(sha256Buffer(skill), closure.skillPin.sha256, "skill_pin");
	const preamble = systemPreamble(skill);
	const profile = publicProfile(closure, corpus.commitment, preamble);
	const witness = runtimeWitness(closure, profile);
	const plan = parsePlan(input, profile);
	const parent = realpathSync(evidenceParent);
	const runId = makeRunId(`host-${Date.now()}-${randomBytes(8).toString("hex")}`);
	const root = join(parent, runId);
	createExclusiveDir(root);
	const expected = anchorFor(runId, plan, root);
	const anchorPath = join(parent, `${runId}.expected.json`);
	await publishExclusiveIndex(anchorPath, JSON.stringify(expected, null, 2));

	retainCorpus(join(root, "corpus"), corpus);
	writeExclusiveFile(join(root, "skill.bin"), skill);
	writeExclusiveFile(join(root, "plan.json"), JSON.stringify(plan));
	const journal = join(root, "run.jsonl");
	let seq = 0;
	const encode = (kind: string, body: object): string =>
		`${JSON.stringify({ kind, seq: ++seq, runId, plan: expected.plan, ...body })}\n`;
	writeExclusiveFile(journal, encode("run_open", { originalRoot: root, witness }));
	const progression: Prefix[] = [];
	const attemptProjections: ReturnType<PiProjection["finish"]>[] = [];
	const report = (result: Validation) => ({ root, anchorPath, expected, progression, attemptProjections, result });
	const deadline = performance.now() + plan.profile.limits.runDeadlineMs;
	try {
		let progress = reconcile(root, expected, "Prefix");
		if (progress.kind !== "Incomplete") return report(progress);
		progression.push(progress);
		while (progress.next) {
			const identity = progress.next;
			const item = plan.cases.find(c => c.id === identity.caseId);
			requireFact(item, "case_order");
			requireFact(performance.now() + HOST_LIMITS.caseDeadlineMs + HOST_LIMITS.killGraceMs <= deadline, "run_deadline");
			equal(parseRawJson(readEvidence(parent, `${runId}.expected.json`, HOST_LIMITS.controlFrameBytes)), expected, "external_anchor");
			const pi = new PiProjection(HOST_LIMITS.promptPrefix + item.question, join(root, "attempts", identity.attemptId, "cwd"), preamble);
			const mock = await startSyntheticLoopback(req => fixture(identity, req.seq));
			try {
				appendFileSync(journal, encode("attempt_started", { identity }));
				const result = await runAttempt({
					caseLabel: item.id, evidenceParentDir: root, question: item.question, mockBaseUrl: mock.baseUrl,
					providerId: PROOF_MODEL.provider, modelId: PROOF_MODEL.model, thinkingLevel: PROOF_MODEL.thinking,
				}, { cachedClosure: closure, evidence: { identity, anchor: expected, pi, corpus, preamble } });
				const capture = join(root, "attempts", identity.attemptId, "capture");
				if (lstatSync(capture, { throwIfNoEntry: false }) === undefined) return report(inspectRun(root, expected));
				writeExclusiveFile(join(capture, "question.bin"), Buffer.from(item.question));
				writeExclusiveFile(join(capture, "loopback.json"), JSON.stringify(mock.requests.map(({ seq, method, url, bodyText, baseUrl, receivedAt }, i) =>
					({ seq, method, url, bodyText, baseUrl, receivedAt, outcome: mock.outcomes[i] }))));
				if (!result.finalCapture || result.captureDrain?.kind !== "drained" || result.uncertified || result.indexPublicationError !== undefined) {
					return report(inspectRun(root, expected));
				}
				const after = captureExecutionClosure();
				equal(runtimeWitness(after, profile), witness, "closure_postcheck");
				const artifacts = snapshotArtifacts(root, identity);
				const data = join(root, "attempts", identity.attemptId, "data");
				pinAttemptCorpus(data, corpus.commitment);
				const corpusAfter = readPublicCorpus(join(root, "corpus")).commitment;
				equal(corpusAfter, corpus.commitment, "corpus_postcheck");
				appendFileSync(journal, encode("attempt", { identity, artifacts, witness: runtimeWitness(after, profile), corpusAfter }));
				const projection = pi.finish("Prefix");
				progress = reconcile(root, expected, "Prefix", { identity, projection });
				if (progress.kind !== "Incomplete") return report(progress);
				progression.push(progress);
				attemptProjections.push(projection);
			} finally {
				await mock.close();
			}
		}

		appendFileSync(journal, encode("run_closed", { witness }));
		const sealed = await sealRun(root, expected);
		const inspected = inspectRun(root, expected);
		equal(sealed, inspected, "seal_inspect");
		if (sealed.kind === "Complete") {
			await publishExclusiveIndex(join(parent, `${runId}.final.json`), JSON.stringify({
				expected, summary: "summary.json", sha256: sha256Buffer(readEvidence(root, "summary.json", HOST_LIMITS.journalTotalBytes)),
			}, null, 2));
		}
		return report(sealed);
	} catch (error) {
		return report({ kind: "Invalid", invariant: error instanceof Error ? error.message : String(error) });
	}
}
