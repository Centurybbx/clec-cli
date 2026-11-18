import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readEvidence } from "./artifacts.ts";
import { anchorFor, digest, type AttemptIdentity, type ExpectedCommitments, parsePlan, PROOF_MODEL, publicProfile, STATUS_CORPUS } from "./contract.ts";
import { runUnit1Proof } from "./controller.ts";
import { startUnit1LoopbackOpenAI, type MockOpenAIAction } from "./fixtures.ts";
import { createExclusiveDir, parseRawJson, publishExclusiveIndex, writeExclusiveFile } from "./framing.ts";
import { captureExecutionClosure } from "./pins.ts";
import { makeRunId, UNIT1_LIMITS } from "./types.ts";
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
export async function collectRun(input: unknown, evidenceParent: string, fixture: LoopbackFixture) {
	const closure = captureExecutionClosure();
	const witness = runtimeWitness(closure);
	const plan = parsePlan(input, publicProfile(closure));
	const parent = realpathSync(evidenceParent);
	const runId = makeRunId(`u2-${Date.now()}-${randomBytes(8).toString("hex")}`);
	const root = join(parent, runId);
	createExclusiveDir(root);
	const expected = anchorFor(runId, plan, root);
	const anchorPath = join(parent, `${runId}.expected.json`);
	await publishExclusiveIndex(anchorPath, JSON.stringify(expected, null, 2));

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
			requireFact(performance.now() + UNIT1_LIMITS.caseDeadlineMs + UNIT1_LIMITS.killGraceMs <= deadline, "run_deadline");
			equal(parseRawJson(readEvidence(parent, `${runId}.expected.json`, UNIT1_LIMITS.controlFrameBytes)), expected, "external_anchor");
			const before = captureExecutionClosure();
			equal(runtimeWitness(before), witness, "closure_prelaunch");
			const pi = new PiProjection(UNIT1_LIMITS.promptPrefix + item.question, join(root, "attempts", identity.attemptId, "cwd"));
			const mock = await startUnit1LoopbackOpenAI(req => fixture(identity, req.seq));
			try {
				const result = await runUnit1Proof({
					caseLabel: item.id, evidenceParentDir: root, question: item.question, mockBaseUrl: mock.baseUrl,
					providerId: PROOF_MODEL.provider, modelId: PROOF_MODEL.model, thinkingLevel: PROOF_MODEL.thinking,
				}, { cachedClosure: before, evidence: { identity, anchor: expected, pi } });
				if (result.piStop?.reapedAt == null || !result.groupObservations.every(group => group.closure?.kind === "gone")) {
					return report({ ...progress, invariant: "ownership_incomplete" });
				}
				const capture = join(root, "attempts", identity.attemptId, "capture");
				writeExclusiveFile(join(capture, "question.bin"), Buffer.from(item.question));
				writeExclusiveFile(join(capture, "loopback.json"), JSON.stringify(mock.requests.map(({ seq, method, url, bodyText }, i) =>
					({ seq, method, url, bodyText, outcome: mock.outcomes[i] }))));
				const after = captureExecutionClosure();
				equal(runtimeWitness(after), witness, "closure_postcheck");
				const artifacts = snapshotArtifacts(root, identity);
				const data = join(root, "attempts", identity.attemptId, "data");
				const corpusAfter = readdirSync(data).length === 0 ? STATUS_CORPUS : null;
				appendFileSync(journal, encode("attempt", { identity, artifacts, witness: runtimeWitness(after), corpusAfter }));
				progress = reconcile(root, expected, "Prefix");
				if (progress.kind !== "Incomplete") return report(progress);
				progression.push(progress);
				const raw = progress.attempts.at(-1);
				const live = pi.finish("Prefix");
				equal(live.answer, raw?.answer, "live_closed_answer");
				equal(live.workObserved, raw?.workObserved, "live_closed_work");
				equal(live.calls, raw?.calls.length, "live_closed_calls");
				attemptProjections.push(live);
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
				expected, summary: "summary.json", sha256: digest(sealed.summary),
			}, null, 2));
		}
		return report(sealed);
	} catch (error) {
		return report({ kind: "Invalid", invariant: error instanceof Error ? error.message : String(error) });
	}
}
