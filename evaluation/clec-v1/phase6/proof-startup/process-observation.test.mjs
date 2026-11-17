import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { observeGroupInProcessTable, readOsProcessTable } from "./process-group.ts";

const valid = "123 1 123 Tue Nov 17 23:00:00 2026 native-child\n";

function withProcessTable(raw, check) {
  const original = childProcess.execFileSync;
  try {
    childProcess.execFileSync = () => raw;
    syncBuiltinESMExports();
    check();
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
}

test("malformed process rows never establish absence", () => {
  for (const raw of ["unparseable process table row\n", valid + "broken trailing row\n", "", "\n"]) {
    withProcessTable(raw, () => {
      assert.equal(readOsProcessTable().ok, false);
      assert.equal(observeGroupInProcessTable({ pgid: 123, knownIdentities: [], monotonicMs: 0 }).kind, "unknown");
    });
  }
});

test("unsafe process identities never establish absence", () => {
  for (const raw of [valid.replace("123 1 123", "9007199254740993 1 123"), valid.replace("123 1 123", "123 1 9007199254740993")]) {
    withProcessTable(raw, () => assert.equal(readOsProcessTable().ok, false));
  }
});

test("complete valid process observations distinguish alive and gone", () => {
  withProcessTable(valid, () => {
    assert.equal(observeGroupInProcessTable({ pgid: 123, knownIdentities: [], monotonicMs: 0 }).kind, "alive");
    assert.equal(observeGroupInProcessTable({ pgid: 456, knownIdentities: [], monotonicMs: 0 }).kind, "gone");
  });
});
