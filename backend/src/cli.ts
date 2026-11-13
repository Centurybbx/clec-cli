import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { publicError, ClecError } from './domain/errors.js';
import { EvidenceStore } from './evidence/store.js';
import { buildGeneration, currentGeneration } from './ingestion/generation.js';
import { ask } from './qa/service.js';
import { catalogueCorpus } from './catalog/index.js';
import { atomicJson, catalogueOutputPath } from './io/catalogue-output.js';
import { hash } from './domain/hash.js';
import { serve } from './app/index.js';
import { sessionCommand } from './app/session-cli.js';
import { scopedQuestion } from './io/scoped-question.js';
import { verifyServingSettings } from './ingestion/settings.js';
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  const app = config();
  const [command, ...args] = process.argv.slice(2);
  if (command === 'catalogue') {
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i]; const value = args[i + 1];
      if (!name || !['--root', '--manifest', '--report'].includes(name) || !value || flags.has(name)) throw new ClecError('USAGE', 'catalogue --root <workspace> --manifest <state-dir/intake.json> --report <state-dir/corpus.json>');
      flags.set(name, value);
    }
    if (flags.size !== 3) throw new ClecError('USAGE', 'catalogue requires --root, --manifest and --report.');
    const root = resolve(flags.get('--root')!);
    const manifestPath = await catalogueOutputPath(flags.get('--manifest')!, app.stateRoot, root);
    const reportPath = await catalogueOutputPath(flags.get('--report')!, app.stateRoot, root);
    if (manifestPath === reportPath) throw new ClecError('UNSAFE_OUTPUT', 'Intake and report paths must differ.');
    const catalogue = await catalogueCorpus(root);
    const manifestText = `${JSON.stringify(catalogue.manifest, null, 2)}\n`;
    const outputs = { manifestPath, manifestSha256: hash(manifestText), reportPath };
    // Each file is atomic. Publish report first; its hash detects a crash between the two writes.
    await atomicJson(reportPath, `${JSON.stringify({ ...catalogue, outputs }, null, 2)}\n`);
    await atomicJson(manifestPath, manifestText);
    write({ ...outputs, selectedSources: catalogue.coverage.total.selectedSources,
      selectedReadySources: catalogue.entries.filter(e => e.selected && e.category === 'ready').length,
      issues: catalogue.issues.length, complete: false, coverage: catalogue.coverage });
  } else if (command === 'build') {
    if (!args[0] || args[0].startsWith('--') || args.length > 2 || (args[1] !== undefined && !['--hybrid', '--lexical'].includes(args[1]))) throw new ClecError('USAGE', 'build <intake.json> [--hybrid|--lexical] (hybrid default; lexical is diagnostic degraded retrieval)');
    const generation = await buildGeneration({ workspace: app.workspace, stateRoot: app.stateRoot, manifestPath: resolve(args[0]), hybrid: !args.includes('--lexical'), signal: controller.signal });
    write({ directory: generation.directory, ...generation.metadata });
  } else if (command === 'status') {
    const generation = await currentGeneration(app.stateRoot);
    const store = new EvidenceStore(join(generation.directory, 'evidence.sqlite'));
    try { write({ ...generation.metadata, directory: generation.directory, evidence: store.counts() }); } finally { store.close(); }
  } else if (command === 'source') {
    const generation = await currentGeneration(app.stateRoot);
    const store = new EvidenceStore(join(generation.directory, 'evidence.sqlite'));
    try {
      if (!args[0]) throw new ClecError('USAGE', 'source <source-id>');
      write({ source: store.source(args[0]), sections: store.sections(args[0]), original: store.original(args[0]) });
    } finally { store.close(); }
  } else if (command === 'serve') {
    if (args.length) throw new ClecError('USAGE', 'serve (configure port using CLEC_PORT)');
    await serve(app, controller.signal);
  } else if (command === 'session') {
    await sessionCommand(app, args, controller.signal, write);
  } else if (command === 'ask') {
    const { question, filter } = scopedQuestion(args);
    if (!await ask(app, question, write, controller.signal, filter)) process.exitCode = 1;
  } else if (command === 'qmd-serve') {
    const generation = await currentGeneration(app.stateRoot);
    await verifyServingSettings(generation.metadata.buildSettings, controller.signal);
    const port = Number(args[0] ?? 8181);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ClecError('USAGE', 'qmd-serve [port:1024–65535]');
    // Execute the installed public CLI; never reach into QMD private database internals.
    const executable = fileURLToPath(new URL('../node_modules/.bin/qmd', import.meta.url));
    const childEnvironment = { ...process.env };
    delete childEnvironment.DEEPSEEK_API_KEY;
    const child = spawn(executable, ['mcp', '--http', '--host', 'localhost', '--port', String(port)], {
      cwd: generation.directory, stdio: 'inherit',
      env: { ...childEnvironment, INDEX_PATH: join(generation.directory, 'qmd.sqlite'), QMD_CONFIG_DIR: generation.directory,
        // QMD defaults to the "index" config; generation has its isolated index.yml.
      },
    });
    const stop = () => child.kill('SIGINT');
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      process.exitCode = await new Promise<number>((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)); });
    } finally { controller.signal.removeEventListener('abort', stop); }
  } else {
    write({ usage: ['catalogue --root <workspace> --manifest <state-dir/intake.json> --report <state-dir/corpus.json>', 'build <intake.json> [--hybrid|--lexical] (hybrid default; lexical degraded)', 'qmd-serve [port]', 'serve', 'session create [title]', 'session list', 'session ask <session-id> <question>', 'session history <session-id>', 'ask [--scope <JSON>] <question>', 'status', 'source <source-id>'], configuration: { provider: 'deepseek', model: app.model, apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY?.trim()), stateRoot: app.stateRoot, port: app.port } });
    if (command && command !== 'help') process.exitCode = 1;
  }
} catch (error) { write({ type: 'error', ...publicError(error) }); process.exitCode = 1; }
finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
