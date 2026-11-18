import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import type * as TypeScript from "typescript";
import type { FilePin } from "./pins.ts";

const entrypoints = ["runner.ts", "controller.ts", "group-helper.mjs", "clec-adapter.ts"];

export function verifyHostImports(input: {
	readonly root: string;
	readonly files: readonly FilePin[];
	readonly ts: typeof TypeScript;
}): void {
	const { root, files, ts } = input;
	const pinned = new Map(files.map(file => [file.logicalPath, file]));
	const checked = new Set<string>();

	const visit = (path: string): void => {
		if (checked.has(path)) return;
		const file = pinned.get(path);
		if (!file) throw new Error(`Unlisted host import: ${path}`);
		checked.add(path);
		const name = path.slice(root.length + 1);
		const source = ts.createSourceFile(path, readFileSync(file.canonicalPath, "utf8"), ts.ScriptTarget.ESNext, true);
		const check = (specifier: TypeScript.Node | undefined, typeOnly: boolean): void => {
			if (!specifier || !ts.isStringLiteral(specifier)) throw new Error(`Unresolved host import in ${name}`);
			const target = specifier.text;
			if (target.startsWith("node:") && isBuiltin(target)) return;
			// Pi extension resolution and the closure parser are pinned separately.
			if (name === "clec-adapter.ts" &&
				(target === "typebox" || (typeOnly && target === "@earendil-works/pi-coding-agent"))) return;
			if ((name === "source-closure.ts" || name === "pins.ts") && typeOnly && target === "typescript") return;
			if (!target.startsWith("./") && !target.startsWith("../")) {
				throw new Error(`Unlisted external host import in ${name}: ${target}`);
			}
			const resolved = resolve(dirname(path), target);
			if (!resolved.startsWith(`${root}/`)) throw new Error(`Host import escapes proof root in ${name}: ${target}`);
			visit(resolved);
		};
		const walk = (node: TypeScript.Node): void => {
			if (ts.isImportDeclaration(node)) check(node.moduleSpecifier, node.importClause?.isTypeOnly === true);
			if (ts.isExportDeclaration(node) && node.moduleSpecifier) check(node.moduleSpecifier, node.isTypeOnly);
			if (ts.isImportTypeNode(node)) {
				check(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
			}
			if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require")))) {
				throw new Error(`Dynamic host import in ${name}`);
			}
			ts.forEachChild(node, walk);
		};
		walk(source);
	};

	for (const name of entrypoints) visit(resolve(root, name));
}
