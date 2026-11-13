export class ClecError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ClecError('CANCELLED', 'Run cancelled or its deadline expired.');
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ClecError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'Operation failed. No answer was completed; inspect configuration and local service availability.' };
}
