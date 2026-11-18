import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { observeGroupInProcessTable, readOsProcessTable } from "../capture/process-group.ts";

const valid = "123 1 123 Tue Nov 17 23:00:00 2026 native-child\n";

async function withProcessTable(raw, check) {
  const original = childProcess.execFile;
  try {
    childProcess.execFile = (_file, _args, options, callback) => {
      assert.equal(options.env.LC_ALL, "C");
      assert.equal(options.env.LANG, "C");
      queueMicrotask(() => callback(raw instanceof Error ? raw : null, raw, ""));
    };
    syncBuiltinESMExports();
    await check();
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
}

test("malformed process rows never establish absence", async () => {
  for (const raw of ["unparseable process table row\n", valid + "broken trailing row\n", "", "\n"]) {
    await withProcessTable(raw, async () => {
      assert.equal((await readOsProcessTable()).ok, false);
      assert.equal((await observeGroupInProcessTable({ pgid: 123, knownIdentities: [], monotonicStartMs: performance.now() })).kind, "unknown");
    });
  }
});

test("unsafe process identities never establish absence", async () => {
  for (const raw of [valid.replace("123 1 123", "9007199254740993 1 123"), valid.replace("123 1 123", "123 1 9007199254740993")]) {
    await withProcessTable(raw, async () => assert.equal((await readOsProcessTable()).ok, false));
  }
});

test("complete valid process observations distinguish alive and gone", async () => {
  const kill = process.kill;
  try {
    process.kill = (pid, signal) => {
      assert.equal(pid, -456);
      assert.equal(signal, 0);
      throw Object.assign(new Error("Group absent"), { code: "ESRCH" });
    };
    await withProcessTable(valid, async () => {
      assert.equal((await observeGroupInProcessTable({ pgid: 123, knownIdentities: [], monotonicStartMs: performance.now() })).kind, "alive");
      assert.equal((await observeGroupInProcessTable({ pgid: 456, knownIdentities: [], monotonicStartMs: performance.now() })).kind, "gone");
    });
  } finally {
    process.kill = kill;
  }
});

test("kernel presence and indeterminate probe failures cannot establish absence", async () => {
  const kill = process.kill;
  try {
    for (const [code, reason] of [[null, /still reports/], ["EPERM", /denied access/], ["EINVAL", /probe failed/]]) {
      let probes = 0;
      process.kill = (pid, signal) => {
        assert.equal(pid, -456);
        assert.equal(signal, 0);
        probes++;
        if (code) throw Object.assign(new Error(code), { code });
        return true;
      };
      await withProcessTable(valid, async () => {
        const result = await observeGroupInProcessTable({ pgid: 456, knownIdentities: [], monotonicStartMs: performance.now() });
        assert.equal(probes, 1);
        assert.equal(result.kind, "unknown");
        assert.match(result.reason, reason);
      });
    }
  } finally {
    process.kill = kill;
  }
});

test("truncated rows and permission failure stay unknown", async () => {
  for (const raw of [valid.slice(0, -1), new Error("EACCES")]) {
    await withProcessTable(raw, async () => {
      assert.equal((await readOsProcessTable()).ok, false);
    });
  }
});

test("real observer finds its own process", async () => {
  const table = await readOsProcessTable();
  assert.equal(table.ok, true, table.reason);
  assert.ok(table.entries.some((row) => row.pid === process.pid));
});

test("a reused known PID remains unknown even outside the owned group", async () => {
  await withProcessTable(valid, async () => {
    const observed = await observeGroupInProcessTable({
      pgid: 456,
      knownIdentities: [{ pid: 123, lstart: "Mon Nov 16 23:00:00 2026" }],
      monotonicStartMs: performance.now(),
    });
    assert.equal(observed.kind, "unknown");
    assert.match(observed.reason, /Identity changed/);
  });
});
