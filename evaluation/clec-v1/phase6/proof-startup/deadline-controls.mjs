import assert from "node:assert/strict";
import cp from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runUnit1Proof } from "./controller.ts";
import { startUnit1LoopbackOpenAI } from "./fixtures.ts";
import { BoundedJournalWriter, BoundedRawSink, byDeadline } from "./framing.ts";
import { captureExecutionClosure } from "./pins.ts";
import { armStop, ProcessGroupRegistry, readOsProcessTable } from "./process-group.ts";

const root = fs.mkdtempSync(join(process.argv[2] ?? "/tmp", "clec-deadline-controls-"));
const log = [];
const originalKill = process.kill;
const originalSpawn = cp.spawn;
const originalExec = cp.execFile;
const node = process.execPath;
const sourceHead = cp.execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const oldHead = "9a0124487f3fca68e99376646c28ed47874d0c13";
const oldSource = join(root, "old-source");
fs.mkdirSync(oldSource, { mode: 0o700 });
for (const file of ["framing.ts", "pins.ts", "types.ts", "process-group.ts"]) {
  const bytes = cp.execFileSync("/usr/bin/git", ["show", `${oldHead}:evaluation/clec-v1/phase6/proof-startup/${file}`]);
  fs.writeFileSync(join(oldSource, file), bytes, { flag: "wx" });
}
const oldFraming = await import(join(oldSource, "framing.ts"));
const oldGroups = await import(join(oldSource, "process-group.ts"));
const tempFile = await open(join(root, "prototype-probe"), "wx");
const fileHandle = Object.getPrototypeOf(tempFile);
await tempFile.close();
const actualWrite = fileHandle.write;
const actualSyncWrite = fs.writeSync;
const closure = captureExecutionClosure();

function privateDir(label) {
  const dir = join(root, label);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

async function bounded(promise, ms = 4_000) {
  const result = await byDeadline(promise, performance.now() + ms);
  assert.equal(result.kind, "completed", "control wait exceeded its deadline");
  return result.value;
}

function observeOwned(pids, pgids) {
  return cp.execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" })
    .trim().split("\n").map((line) => line.trim().split(/\s+/))
    .filter(([pid, pgid]) => pids.includes(Number(pid)) || pgids.includes(Number(pgid)));
}

function trackSignals(pids) {
  const calls = [];
  process.kill = function (pid, signal) {
    if (pids.includes(pid)) calls.push({ pid, signal, at: performance.now(), wallMs: Date.now() });
    return originalKill.call(this, pid, signal);
  };
  return calls;
}

async function target({ detached = true, ignoreTerm = true } = {}) {
  const child = originalSpawn(node, ["-e", `
    if (${ignoreTerm}) process.on("SIGTERM", () => {});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `], { detached, stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(child, "exit");
  await bounded(once(child.stdout, "data"));
  assert.ok(child.pid > 0);
  return { child, pid: child.pid, exited, detached };
}

async function reapOwned(...targets) {
  for (const { child } of targets) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await bounded(Promise.all(targets.map(({ exited }) => exited)));
}

function reserve(registry, dir, leaseId, owned) {
  const entry = registry.reserve({ captureDir: dir, leaseId, onOverflow() {}, onSinkFailure() {} });
  Object.assign(entry, { child: owned.child, pgid: owned.pid, helperPid: owned.pid, state: "Released" });
  return entry;
}
const record = { runId: "probe", attemptId: "probe", kind: "plan_committed", body: { public: true } };

async function oldPsSensitivity(dir) {
  const owned = await target();
  const registry = new oldGroups.ProcessGroupRegistry(performance.now());
  reserve(registry, dir, "old-ps", owned);
  const journal = new oldFraming.BoundedJournalWriter({ path: join(dir, "journal") });
  const signals = trackSignals([-owned.pid]);
  const original = cp.execFileSync;
  let delayedAt = null;
  try {
    cp.execFileSync = (file, args, options) => {
      if (file === "ps" && delayedAt === null) {
        delayedAt = performance.now();
        original("/bin/sleep", ["2.2"]);
      }
      return original(file, args, options);
    };
    syncBuiltinESMExports();
    const triggerAt = performance.now();
    await registry.stopAll({ journal, runId: "probe", attemptId: "probe" });
    const kill = signals.find((event) => event.signal === "SIGKILL");
    assert.ok(delayedAt !== null && kill.at - triggerAt > 2_000);
    await bounded(owned.exited);
    const survivors = observeOwned([], [owned.pid]);
    assert.deepEqual(survivors, []);
    return { triggerAt, delayedAt, signals, killAfterMs: kill.at - triggerAt, survivors };
  } finally {
    cp.execFileSync = original;
    syncBuiltinESMExports();
    process.kill = originalKill;
    journal.close();
    await reapOwned(owned);
  }
}

function delayObserverOnce(delayMs, { stale = false } = {}) {
  const invoked = Promise.withResolvers();
  const completed = Promise.withResolvers();
  cp.execFile = (file, args, options, callback) => {
    if (file !== "/bin/ps") return originalExec(file, args, options, callback);
    cp.execFile = originalExec;
    syncBuiltinESMExports();
    const startedAt = performance.now();
    const source = `
      const {execFileSync} = require("node:child_process");
      const list = () => execFileSync("/bin/ps", JSON.parse(process.argv[1]));
      const cached = ${stale} ? list() : null;
      setTimeout(() => process.stdout.write(cached ?? list()), ${delayMs});
    `;
    const observer = originalExec(node, ["-e", source, JSON.stringify(args)], options, (...results) => {
      completed.resolve({ finishedAt: performance.now(), error: results[0]?.message ?? null });
      callback(...results);
    });
    invoked.resolve({ observerPid: observer.pid, startedAt });
    return observer;
  };
  syncBuiltinESMExports();
  return { invoked: invoked.promise, completed: completed.promise };
}

async function asyncPsTiming(dir, multi) {
  const owned = [await target()];
  if (multi) owned.push(await target(), await target({ detached: false }));
  const groups = multi ? owned.slice(0, 2) : owned;
  const registry = new ProcessGroupRegistry(performance.now());
  const entries = groups.map((child, index) => reserve(registry, dir, `group-${index}`, child));
  const signals = trackSignals(groups.map(({ pid }) => -pid));
  let heldWrite;
  const closeGate = Promise.withResolvers();
  let closeRequestedAt = null;
  let closeReleasedAt = null;
  let observation;
  let pi;
  const delayed = delayObserverOnce(2_250, { stale: multi });
  try {
    if (multi) {
      const writing = Promise.withResolvers();
      fileHandle.write = async function (...args) {
        writing.resolve();
        await closeGate.promise;
        closeReleasedAt = performance.now();
        return actualWrite.apply(this, args);
      };
      heldWrite = entries[0].stdoutSink.writeChunk(Buffer.from("pending capture"));
      await bounded(writing.promise);
      const sink = entries[0].stdoutSink;
      const close = sink.close;
      sink.close = (deadline) => {
        closeRequestedAt = performance.now();
        return close.call(sink, deadline);
      };
      const pendingTable = readOsProcessTable();
      await bounded(delayed.invoked);
      await sleep(850);
      void pendingTable;
    }
    const triggerAt = performance.now();
    const trigger = { at: triggerAt, detectedAt: performance.now() };
    if (multi) pi = armStop({ child: owned[2].child, trigger, graceMs: 350 });
    registry.beginStop(trigger);
    const finishing = registry.finishStop();
    await sleep(550);
    registry.beginStop({ at: performance.now(), detectedAt: performance.now() });
    closeGate.resolve();
    await bounded(finishing);
    if (pi) await bounded(pi.reaped);
    const invocation = await bounded(delayed.invoked);
    const completion = await bounded(delayed.completed);
    observation = { ...invocation, ...completion };
    assert.ok(completion.finishedAt - invocation.startedAt >= (multi ? 2_200 : 1_900));
    assert.deepEqual(observeOwned([invocation.observerPid], []), [], "observer must be reaped");
    assert.deepEqual(observeOwned(owned.map(({ pid }) => pid), groups.map(({ pid }) => pid)), []);
    for (const entry of entries) {
      const events = signals.filter(({ pid }) => pid === -entry.pgid);
      assert.deepEqual(events.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
      assert.ok(events[1].at - triggerAt >= 400 && events[1].at - triggerAt < 2_000);
      assert.ok(events[1].at < completion.finishedAt);
      assert.equal(entry.stop.evidence.triggerAt, triggerAt);
      assert.equal(entry.state, multi ? "Closed" : "Unknown");
    }
    if (multi) {
      assert.ok(pi.evidence.killAttemptAt - triggerAt >= 350 && pi.evidence.killAttemptAt < signals[2].at);
      assert.ok(closeRequestedAt < signals[2].at && closeReleasedAt > signals[2].at);
      assert.ok(Math.abs(signals[2].at - signals[3].at) < 30);
    }
    return { triggerAt, observation, signals, pi: pi?.evidence, closeRequestedAt, closeReleasedAt,
      groups: entries.map((entry) => ({ state: entry.state, closure: entry.closure, stop: entry.stop.evidence })), survivors: [] };
  } finally {
    closeGate.resolve();
    await heldWrite;
    fileHandle.write = actualWrite;
    cp.execFile = originalExec;
    syncBuiltinESMExports();
    process.kill = originalKill;
    await reapOwned(...owned);
  }
}

const fifoReleaser = `
import json, os, sys, time
fifo, marker = sys.argv[1:]
fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
print("ready", flush=True)
while not os.path.exists(marker): time.sleep(.005)
with open(marker) as f: expected = int(f.read())
os.set_blocking(fd, True)
time.sleep(2.4)
released = time.time_ns() / 1000000
size = 0
while size < expected:
    data = os.read(fd, min(65536, expected-size))
    if not data: raise RuntimeError("unexpected EOF")
    size += len(data)
print(json.dumps(dict(releasedWallMs=released, readBytes=size)), flush=True)
os.close(fd)
`;

async function blockSyscall(dir, mode, old) {
  const owned = await target();
  const signals = trackSignals([-owned.pid]);
  const path = join(dir, "write.pipe");
  const marker = join(dir, "write-start");
  cp.execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
  const releaser = originalSpawn("/usr/bin/python3", ["-c", fifoReleaser, path, marker], { stdio: ["ignore", "pipe", "inherit"] });
  const released = once(releaser, "exit");
  await bounded(once(releaser.stdout, "data"));
  let output = "";
  releaser.stdout.on("data", (chunk) => { output += chunk; });
  const { O_NONBLOCK, O_WRONLY } = fs.constants;
  const filler = fs.openSync(path, O_WRONLY | O_NONBLOCK);
  const fd = fs.openSync(path, O_WRONLY);
  let filled = 0;
  try {
    while (filled < 4 * 1024 * 1024) filled += fs.writeSync(filler, Buffer.alloc(65_536));
    assert.fail("could not fill the private FIFO");
  } catch (err) {
    assert.equal(err.code, "EAGAIN");
  } finally {
    fs.closeSync(filler);
  }
  let work;
  let syscallStart;
  let syscallEnd;
  let ticket;
  let drain;
  let ioFailure;
  const storage = old ? oldFraming : { BoundedRawSink, BoundedJournalWriter };
  const writer = mode === "raw"
    ? new storage.BoundedRawSink({ path: join(dir, "raw"), maxBytes: 65_536, onWriteFailure: (err) => { ioFailure = err; } })
    : new storage.BoundedJournalWriter({ path: join(dir, "journal") });
  if (writer.ready) assert.ok(await writer.ready);
  const triggerAt = performance.now() + 100;
  const killTimer = setTimeout(() => {
    if (old) process.kill(-owned.pid, "SIGKILL");
    else ticket = armStop({ child: owned.child, pgid: owned.pid, trigger: { at: triggerAt, detectedAt: performance.now() }, graceMs: 400 });
  }, old ? 500 : 100);
  const syscalls = [];
  const startWrite = (length) => {
    if (!syscallStart) {
      const pendingMarker = marker + ".pending";
      const countBytes = Buffer.from(String(filled + length));
      const markerFd = fs.openSync(pendingMarker, "wx");
      actualSyncWrite(markerFd, countBytes, 0, countBytes.length, null);
      fs.closeSync(markerFd);
      fs.renameSync(pendingMarker, marker);
      syscallStart = { at: performance.now(), wallMs: Date.now(), length };
    }
  };
  try {
    if (old) {
      fs.writeSync = (_file, buffer, offset, length) => {
        startWrite(length);
        const n = actualSyncWrite(fd, buffer, offset, length, null);
        syscallEnd = performance.now();
        syscalls.push({ requested: length, written: n, completedAt: syscallEnd });
        return n;
      };
      syncBuiltinESMExports();
    } else {
      fileHandle.write = async function (buffer, offset, length) {
        startWrite(length);
        const bytesWritten = await new Promise((resolve, reject) => {
          fs.write(fd, buffer, offset, length, null, (err, n) => err ? reject(err) : resolve(n));
        });
        syscallEnd = performance.now();
        syscalls.push({ requested: length, written: bytesWritten, completedAt: syscallEnd });
        return { bytesWritten, buffer };
      };
    }
    const backing = Buffer.alloc(256 * 1024);
    work = Promise.resolve(mode === "raw" ? writer.writeChunk(backing.subarray(0, 65_536)) : writer.append(record, 0, old ? false : "normal"));
    if (!old) {
      drain = await writer.close(triggerAt + 2_000);
      assert.equal(drain.kind, "incomplete");
      assert.equal(syscallEnd, undefined, "syscall should still be pending at the drain deadline");
      if (mode === "raw") assert.equal(writer.maxPendingObserved, 65_536);
    }
    const result = await bounded(work);
    assert.ok(old ? result === true || result.ok : result.kind === "written" || result.ok, ioFailure?.stack ?? JSON.stringify(result));
    await bounded(released);
    const external = JSON.parse(output.trim());
    assert.equal(external.readBytes, filled + syscallStart.length);
    assert.ok(external.releasedWallMs - syscallStart.wallMs > 2_200);
    const kill = signals.find((event) => event.signal === "SIGKILL");
    assert.ok(kill);
    assert.ok(old ? kill.at - triggerAt > 2_000 : kill.at - triggerAt < 2_000 && kill.wallMs < external.releasedWallMs);
    if (ticket) assert.equal(ticket.evidence.killAttemptAt <= kill.at, true);
    await bounded(owned.exited);
    const survivors = observeOwned([], [owned.pid]);
    assert.deepEqual(survivors, []);
    return { filled, triggerAt, syscallStart, syscallEnd, syscalls, external, signals, drain, killAfterMs: kill.at - triggerAt, survivors };
  } finally {
    clearTimeout(killTimer);
    fs.writeSync = actualSyncWrite;
    fileHandle.write = actualWrite;
    syncBuiltinESMExports();
    if (releaser.exitCode === null && releaser.signalCode === null) releaser.kill("SIGKILL");
    await bounded(released);
    await work?.catch(() => {});
    await writer.close(performance.now() + 1_000);
    fs.closeSync(fd);
    process.kill = originalKill;
    await reapOwned(owned);
  }
}

async function writerBounds(dir) {
  const rawPath = join(dir, "raw");
  const raw = new BoundedRawSink({ path: rawPath, maxBytes: 65_536 });
  const journalPath = join(dir, "journal");
  const journal = new BoundedJournalWriter({ path: journalPath });
  let partials = 0;
  try {
    fileHandle.write = function (buffer, offset, length) {
      if (length > 8) partials++;
      return actualWrite.call(this, buffer, offset, Math.min(length, 8192));
    };
    const input = Buffer.alloc(65_538, 53);
    assert.equal((await raw.writeChunk(input)).kind, "overflow");
    assert.equal((await raw.close(performance.now() + 500)).kind, "drained");
    assert.deepEqual(fs.readFileSync(rawPath), input.subarray(0, 65_536));

    const gate = Promise.withResolvers();
    const pending = Promise.withResolvers();
    fileHandle.write = async function (...args) {
      pending.resolve();
      await gate.promise;
      return actualWrite.apply(this, args);
    };
    const writes = [journal.append(record, 0)];
    await bounded(pending.promise);
    for (let i = 1; i <= 4; i++) writes.push(journal.append(record, i));
    assert.equal(journal.currentSeq, 0);
    assert.equal((await writes[4]).ok, false);
    gate.resolve();
    const commits = await Promise.all(writes);
    assert.equal(commits.filter(({ ok }) => ok).length, 1);

    const brokenPath = join(dir, "failed-journal");
    const broken = new BoundedJournalWriter({ path: brokenPath });
    let first = true;
    fileHandle.write = async function (buffer, offset, length) {
      if (first) {
        first = false;
        return actualWrite.call(this, buffer, offset, 7);
      }
      return new Promise((resolve, reject) => fs.write(999_999, buffer, offset, length, null, (err, n) => {
        if (err) reject(err);
        else resolve({ bytesWritten: n, buffer });
      }));
    };
    const failure = await broken.append(record, 0);
    assert.equal(failure.ok, false);
    assert.equal(broken.currentSeq, 0);
    assert.equal((await broken.append(record, 1, "emergency")).ok, false);
    assert.equal((await broken.close(performance.now() + 500)).kind, "incomplete");
    assert.equal(fs.statSync(brokenPath).size, 7);
    return { partials, commits, failure, retainedBackingBytes: raw.maxPendingObserved };
  } finally {
    fileHandle.write = actualWrite;
    await journal.close(performance.now() + 1_000);
    await raw.close(performance.now() + 1_000);
  }
}

async function loopbackCommit(dir, kind, mode) {
  const native = kind !== "provider_grant";
  const sentinel = join(dir, "sentinel");
  const nativePath = join(dir, "native.mjs");
  fs.writeFileSync(nativePath, `#!${node}
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(sentinel)}, "started\\n");
    process.stdout.write("exact stdout £\\n");
  `, { mode: 0o700, flag: "wx" });
  const server = await startUnit1LoopbackOpenAI((request) => native && request.seq === 1
    ? { kind: "tool_calls", calls: [{ id: "owned-call", name: "clec", rawArgumentsJson: '{"action":"status"}' }] }
    : { kind: "text", text: "Public synthetic answer." });
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const released = Promise.withResolvers();
  let enteredAt;
  let releasedAt;
  let externalPiKillAt;
  let pi;
  let helper;
  const wire = [];
  const captureWrites = (child, channel) => {
    const socket = child.stdio[3];
    const write = socket.write;
    socket.write = function (bytes, ...args) {
      const frame = JSON.parse(String(bytes));
      wire.push({ channel, kind: frame.kind, at: performance.now() });
      return write.call(this, bytes, ...args);
    };
  };
  cp.spawn = (...args) => {
    const child = originalSpawn(...args);
    if (args[1]?.includes("--mode")) {
      pi = { child, exited: once(child, "exit") };
      captureWrites(child, "pi");
    } else if (args[1]?.includes("--lease")) {
      helper = { child, exited: once(child, "exit") };
      captureWrites(child, "helper");
    }
    return child;
  };
  syncBuiltinESMExports();
  const actualDatasync = fileHandle.datasync;
  const run = () => runUnit1Proof({
    caseLabel: `commit-${kind}-${mode}`, evidenceParentDir: dir, question: "Public synthetic control.",
    mockBaseUrl: server.baseUrl, faults: { nativeExecOverride: nativePath, nativeArgsOverride: [], nativeSentinelPath: sentinel },
  }, { cachedClosure: closure });
  let result;
  let work;
  let blockedFd;
  try {
    fileHandle.write = async function (buffer, offset, length) {
      if (offset === 0 && buffer.includes(Buffer.from(`"kind":"${kind}"`))) {
        enteredAt = performance.now();
        if (mode === "sync-before-release") {
          blockedFd = this.fd;
        } else {
          entered.resolve();
          if (mode === "write-failure") throw new Error("Test journal write failure");
          await gate.promise;
          releasedAt = performance.now();
          released.resolve();
        }
      }
      return actualWrite.call(this, buffer, offset, length);
    };
    fileHandle.datasync = async function (...args) {
      if (blockedFd === this.fd) {
        entered.resolve();
        await gate.promise;
        await actualDatasync.apply(this, args);
        releasedAt = performance.now();
        released.resolve();
        blockedFd = undefined;
      } else {
        await actualDatasync.apply(this, args);
      }
    };
    work = run();
    await bounded(entered.promise);
    const expectedBefore = native ? 1 : 0;
    const releaseKind = native ? ["go"] : ["provider_permit"];
    assert.equal(server.requests.length, expectedBefore);
    assert.equal(fs.existsSync(sentinel), false);
    assert.ok(!wire.some(({ kind: message }) => releaseKind.includes(message)));
    if (mode === "kill-before-write") {
      externalPiKillAt = performance.now();
      assert.equal(pi.child.kill("SIGKILL"), true);
      await bounded(pi.exited);
      await sleep(40);
    }
    gate.resolve();
    if (mode !== "write-failure") await bounded(released.promise);
    result = await bounded(work);
    assert.ok(result.piStop);
    const allowed = mode === "sync-before-release";
    if (allowed) {
      assert.equal(result.status, "Answered");
      assert.equal(server.requests.length, expectedBefore + 1);
      const actual = wire.find(({ kind: message }) => releaseKind.includes(message));
      assert.ok(actual && actual.at >= releasedAt);
      if (native) {
        assert.equal(fs.readFileSync(sentinel, "utf8"), "started\n");
        assert.equal(result.nativeStarts, 1);
        assert.ok(JSON.stringify(server.requests[1].bodyJson).includes("exact stdout £\\n"));
      }
    } else {
      assert.equal(server.requests.length, expectedBefore);
      assert.equal(fs.existsSync(sentinel), false);
      assert.equal(result.nativeStarts, 0);
      assert.ok(!wire.some(({ kind: message }) => releaseKind.includes(message)));
      if (externalPiKillAt !== undefined) {
        assert.ok(result.piStop.triggerAt >= externalPiKillAt && result.piStop.triggerAt < releasedAt);
      }
    }
    const pgids = result.groupObservations.map(({ pgid }) => pgid);
    if (native) assert.equal(result.groupObservations[0]?.closure.kind, "gone");
    const survivors = observeOwned([pi.child.pid], pgids);
    assert.deepEqual(survivors, []);
    return { kind, mode, enteredAt, releasedAt, externalPiKillAt, wire, result, requests: server.requests, survivors };
  } finally {
    gate.resolve();
    fileHandle.write = actualWrite;
    fileHandle.datasync = actualDatasync;
    cp.spawn = originalSpawn;
    syncBuiltinESMExports();
    for (const owned of [pi, helper].filter(Boolean)) {
      if (owned.child.exitCode === null && owned.child.signalCode === null) {
        if (owned === helper) {
          try { originalKill(-owned.child.pid, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        } else {
          owned.child.kill("SIGKILL");
        }
      }
      await bounded(owned.exited);
    }
    await work?.catch(() => {});
    await server.close();
  }
}

async function wrongReporter(dir) {
  const unrelated = await target();
  const badHelper = join(dir, "wrong-helper.mjs");
  fs.writeFileSync(badHelper, `
    import { Socket } from "node:net";
    const output = new Socket({fd: 4});
    output.write(JSON.stringify({
      kind: "helper_ready", leaseId: process.argv[3], pid: ${unrelated.pid}, pgid: ${unrelated.pid}, lstart: null,
    }) + "\\n");
    setInterval(() => {}, 1000);
  `, { flag: "wx" });
  const server = await startUnit1LoopbackOpenAI(() => ({
    kind: "tool_calls", calls: [{ id: "wrong-reporter", name: "clec", rawArgumentsJson: '{"action":"status"}' }],
  }));
  const signals = trackSignals([unrelated.pid, -unrelated.pid]);
  try {
    const result = await runUnit1Proof({
      caseLabel: "wrong-reporter", evidenceParentDir: dir, question: "Public synthetic control.",
      mockBaseUrl: server.baseUrl, faults: { helperPathOverride: badHelper },
    }, { cachedClosure: closure });
    assert.equal(result.nativeStarts, 0);
    assert.equal(result.groupObservations[0].state, "Closed");
    assert.notEqual(result.groupObservations[0].pgid, unrelated.pid);
    assert.match(result.failureReason, /Unexpected helper PID\/PGID/);
    assert.deepEqual(signals, []);
    const unaffected = observeOwned([unrelated.pid], [unrelated.pid]);
    assert.equal(unaffected.length, 1);
    const survivors = observeOwned([], result.groupObservations.map(({ pgid }) => pgid));
    assert.deepEqual(survivors, []);
    return { result, unaffected, signals, survivors };
  } finally {
    process.kill = originalKill;
    await reapOwned(unrelated);
    await server.close();
  }
}

async function retiredLease(dir) {
  const first = await target({ ignoreTerm: false });
  const next = await target();
  const registry = new ProcessGroupRegistry(performance.now());
  const entry = reserve(registry, dir, "retired", first);
  const signals = trackSignals([-first.pid, -next.pid, first.pid, next.pid]);
  try {
    const firstAt = performance.now();
    const ticket = registry.beginOne(entry, { at: firstAt, detectedAt: firstAt });
    await registry.finishOne(entry);
    assert.equal(entry.state, "Closed");
    assert.throws(() => reserve(registry, dir, "retired", next), /Cannot reserve/);
    const nextEntry = reserve(registry, dir, "next", next);
    const secondAt = performance.now();
    assert.equal(registry.beginOne(entry, { at: secondAt, detectedAt: secondAt }), ticket);
    await sleep(500);
    assert.equal(ticket.evidence.killAttemptAt, null);
    assert.deepEqual(signals.map(({ pid, signal }) => ({ pid, signal })), [{ pid: -first.pid, signal: "SIGTERM" }]);
    const unaffected = observeOwned([next.pid], [next.pid]);
    assert.equal(unaffected.length, 1);
    registry.beginStop({ at: performance.now(), detectedAt: performance.now() });
    await registry.finishStop();
    assert.equal(nextEntry.state, "Closed");
    const survivors = observeOwned([first.pid, next.pid], [first.pid, next.pid]);
    assert.deepEqual(survivors, []);
    return { unaffected, survivors, signals, retired: ticket.evidence, next: nextEntry.stop.evidence };
  } finally {
    process.kill = originalKill;
    await reapOwned(first, next);
  }
}

const cases = [
  ["old-ps", oldPsSensitivity],
  ["async-ps-timeout", (dir) => asyncPsTiming(dir, false)],
  ["multi-group", (dir) => asyncPsTiming(dir, true)],
  ["writer-bounds", writerBounds],
  ["wrong-reporter", wrongReporter],
  ["retired-lease", retiredLease],
];
for (const mode of ["raw", "journal"]) {
  for (const old of [true, false]) cases.push([`fifo-${mode}-${old ? "old" : "async"}`, (dir) => blockSyscall(dir, mode, old)]);
}
for (const kind of ["provider_grant", "group_registered", "group_go_sent"]) {
  for (const mode of ["write-failure", "kill-before-write", "sync-before-release"]) {
    cases.push([`${kind}-${mode}`, (dir) => loopbackCommit(dir, kind, mode)]);
  }
}
const receipt = join(root, "receipt.json");
for (const [name, control] of cases) {
  if (process.argv[3] && process.argv[3] !== name) continue;
  const startedUtc = new Date().toISOString();
  try {
    const evidence = await control(privateDir(name));
    log.push({ name, startedUtc, endedUtc: new Date().toISOString(), passed: true, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    log.push({ name, startedUtc, endedUtc: new Date().toISOString(), passed: false, error: error.stack });
    console.error(`FAIL ${name}`, error);
    process.exitCode = 1;
  }
}
assert.ok(log.length);
fs.writeFileSync(receipt, JSON.stringify({ sourceHead, oldHead, closure, log }, null, 2), { flag: "wx" });
console.log(receipt);
