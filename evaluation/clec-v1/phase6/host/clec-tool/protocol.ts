import type { AttemptId, Sha256Hex } from "../contract/types.ts";

export type PipeChildToOuter =
	| {
			readonly kind: "bound_ready";
			readonly seq: number;
			readonly activeTools: readonly string[];
			readonly allTools: ReadonlyArray<{
				readonly name: string;
				readonly exposure: string;
				readonly parameters: unknown;
			}>;
			readonly deferredTools: readonly string[];
			readonly model: { readonly provider: string; readonly id: string } | null;
			readonly thinkingLevel: string | null;
			readonly adapterSha256?: string;
	  }
	| {
			readonly kind: "provider_candidate";
			readonly seq: number;
			readonly watermark: number;
			readonly payloadDigest: Sha256Hex;
			readonly payloadByteLength: number;
			readonly payloadJson: string;
	  }
	| {
			readonly kind: "tool_start_observe";
			readonly seq: number;
			readonly callId: string;
			readonly toolName: string;
			readonly args: unknown;
	  }
	| {
			readonly kind: "tool_execute";
			readonly seq: number;
			readonly callId: string;
			readonly toolName: string;
			readonly params: unknown;
	  }
	| {
			readonly kind: "adapter_fault_note";
			readonly stage: string;
			readonly detail: string;
	  };

export type PipeOuterToChild =
	| {
			readonly kind: "bound_ready_ack";
			readonly seq: number;
			readonly attemptId: AttemptId;
	  }
	| {
			readonly kind: "provider_permit";
			readonly seq: number;
			readonly attemptId: AttemptId;
			readonly watermark: number;
			readonly payloadDigest: Sha256Hex;
	  }
	| {
			readonly kind: "tool_start_ack";
			readonly seq: number;
			readonly callId: string;
			readonly allowed: boolean;
			readonly ordinal?: number;
			readonly rejection?: string;
	  }
	| {
			readonly kind: "tool_result";
			readonly seq: number;
			readonly callId: string;
			readonly isError: boolean;
			readonly text: string;
	  };
