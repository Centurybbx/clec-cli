import { runAttempt } from "../runner/attempt.ts";
import type { ExecutionClosure } from "../capture/pins.ts";
import type { AttemptInput, FaultControls } from "../runner/attempt-types.ts";

export function runUnit1Proof({ faults, ...request }: AttemptInput & { faults?: FaultControls }, options?: { cachedClosure?: ExecutionClosure }) {
	return runAttempt(request, { ...options, faultControls: faults });
}
