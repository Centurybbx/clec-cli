import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PiSessionReference } from '../sessions/types.js';
import { ClecError } from '../domain/errors.js';

function checkedFile(file: string, directory: string): string {
  const root = realpathSync(directory);
  const actual = realpathSync(file);
  const local = relative(root, actual);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || !statSync(actual).isFile()) {
    throw new ClecError('INVALID_PI_SESSION', 'Pi session is outside the configured directory.');
  }
  return actual;
}

/** SDK-managed provider context; host ledger is never copied into agent messages. */
export function openConversation(workspace: string, directory: string, reference: Readonly<PiSessionReference> | null, completedRuns: ReadonlySet<string>): SessionManager {
  try {
    if (!reference) return SessionManager.create(workspace, directory);
    const file = checkedFile(reference.file, directory);
    const manager = SessionManager.open(file, directory, workspace);
    if (manager.getSessionId() !== reference.id || manager.getHeader()?.id !== reference.id) {
      throw new ClecError('INVALID_PI_SESSION', 'Pi session identity does not match its host association.');
    }
    // A crash/failed turn is retained in the append-only tree, but never continued/replayed.
    // Only a new explicit request reaches here. Branch before its uncommitted run marker.
    const branch = manager.getBranch();
    let lastCommitted: string | undefined;
    let pendingRun: string | undefined;
    let reconcile = false;
    for (const entry of branch) {
      if (entry.type !== 'custom') continue;
      const data = entry.data as { runId?: unknown } | undefined;
      if (entry.customType === 'clec_run_begin') {
        if (pendingRun || reconcile) { reconcile = true; break; }
        pendingRun = typeof data?.runId === 'string' ? data.runId : undefined;
        reconcile = true;
        if (!pendingRun || !completedRuns.has(pendingRun)) break;
      }
      if (entry.customType === 'clec_run_committed' && pendingRun && data?.runId === pendingRun && completedRuns.has(pendingRun)) {
        lastCommitted = entry.id;
        pendingRun = undefined;
        reconcile = false;
      }
    }
    if (reconcile) {
      if (lastCommitted) manager.branch(lastCommitted); else manager.resetLeaf();
    }
    return manager;
  } catch (error) {
    if (error instanceof ClecError) throw error;
    throw new ClecError('INVALID_PI_SESSION', 'Pi session could not be restored safely; preserve its file and create a new host session.');
  }
}

export function associateConversation(manager: SessionManager, directory: string, associate: (reference: PiSessionReference) => void): void {
  const file = manager.getSessionFile();
  if (!file) throw new ClecError('INVALID_PI_SESSION', 'Pi did not allocate a durable session file.');
  associate({ id: manager.getSessionId(), file: checkedFile(file, directory) });
}

/** Latest three original questions, newest last, at most 600 UTF-16 units in total.
 * Current question always remains whole; total query <=2000. No assistant text/evidence.
 */
export function retrievalQuestion(question: string, priorQuestions: readonly string[]): string {
  // Deliberately narrow heuristic. Independent questions retain their exact search query.
  const followup = question.length <= 300 && /^(?:那|那么|那麼|這個|这个|這些|这些|它|其|他|她|上述|前面|剛才|刚才|還有|还有|and\b|but\b|what about\b|how about\b|then\b|it\b|that\b|those\b|these\b|they\b|their\b|this\b)/i.test(question.trim());
  if (!followup) return question;
  let remaining = Math.min(600, 2000 - question.length - 40);
  const selected: string[] = [];
  for (const prior of priorQuestions.slice(-3).reverse()) {
    if (remaining <= 0) break;
    const tail = prior.slice(-remaining);
    selected.unshift(tail);
    remaining -= tail.length + 1;
  }
  return selected.length ? `${selected.join('\n')}\nCurrent question: ${question}` : question;
}
