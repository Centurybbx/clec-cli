import { build } from "./publish.js";
import { ClecError } from "./contracts.js";
const args = process.argv.slice(2);
const options = new Map<string, string>();
try {
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key ||
      ![
        "--workspace",
        "--intake",
        "--output",
        "--artifact-url",
      ].includes(key) ||
      !value ||
      options.has(key)
    )
      throw new ClecError(
        "INVALID_ARGUMENT",
        "Use --workspace PATH --intake PATH --output PATH [--artifact-url URL].",
      );
    options.set(key, value);
  }
  const workspace = options.get("--workspace");
  const intake = options.get("--intake");
  const output = options.get("--output");
  const artifactUrl = options.get("--artifact-url");
  if (!workspace || !intake || !output)
    throw new ClecError(
      "INVALID_ARGUMENT",
      "Use --workspace PATH --intake PATH --output PATH [--artifact-url URL].",
    );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      manifest: await build({
        workspace,
        intake,
        output,
        ...(artifactUrl === undefined ? {} : { artifactUrl }),
      }),
    }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: {
        code: error instanceof ClecError ? error.code : "BUILD_FAILED",
        message: error instanceof Error ? error.message : "Build failed.",
      },
    }) + "\n",
  );
  process.exitCode = 1;
}
