import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClecError } from '../domain/errors.js';
/** Derived catalogue output is constrained to the configured state directory. */
export async function catalogueOutputPath(path: string, stateRoot: string, workspace: string): Promise<string> {
  const target = resolve(path);
  await mkdir(stateRoot, { recursive: true });
  const root = await realpath(stateRoot);
  const workspaceRoot = await realpath(workspace);
  const stateRelative = relative(workspaceRoot, root);
  const workspaceRelative = relative(root, workspaceRoot);
  if (!workspaceRelative || (!isAbsolute(workspaceRelative) && workspaceRelative !== '..' && !workspaceRelative.startsWith(`..${sep}`))) throw new ClecError('UNSAFE_OUTPUT', 'State directory must not contain the original workspace.');
  if (stateRelative === '' || stateRelative === 'collection' || stateRelative.startsWith(`collection${sep}`) || stateRelative === 'public-archivedwl-154' || stateRelative.startsWith(`public-archivedwl-154${sep}`)) throw new ClecError('UNSAFE_OUTPUT', 'State directory must not overlap original collection assets or the workspace root.');
  // Canonicalize the nearest existing parent before containment comparison or
  // directory creation. /var and /private/var name the same macOS directory;
  // comparing a real root with a lexical target falsely rejects that alias.
  let ancestor = dirname(target);
  const missing: string[] = [];
  let canonicalAncestor: string;
  while (true) {
    try { canonicalAncestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  const ancestorRel = relative(root, canonicalAncestor);
  if (isAbsolute(ancestorRel) || ancestorRel === '..' || ancestorRel.startsWith(`..${sep}`)) throw new ClecError('UNSAFE_OUTPUT', 'Catalogue outputs must be inside CLEC_STATE_DIR.');
  const parentPath = join(canonicalAncestor, ...missing);
  await mkdir(parentPath, { recursive: true });
  const parent = await realpath(parentPath);
  const parentRel = relative(root, parent);
  if (isAbsolute(parentRel) || parentRel === '..' || parentRel.startsWith(`..${sep}`)) throw new ClecError('UNSAFE_OUTPUT', 'Catalogue output parent resolves outside the state directory.');
  // Renaming replaces a symlink itself, never writes through it to original assets.
  return join(parent, basename(target));
}
export async function atomicJson(path: string, text: string): Promise<void> {
  const temporary = `${path}.writing-${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary); throw error; }
}
