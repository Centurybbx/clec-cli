import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { attachBoundedJsonlReader, BoundedRawSink, publishExclusiveIndex } from "../capture/framing.ts";
import { HOST_LIMITS } from "../contract/types.ts";

const timeout = { timeout: 3_000 };
const deadline = () => performance.now() + 1_000;

async function privateDir(t) {
  const root = await mkdtemp(join(tmpdir(), "clec-framing-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const fault of ["eof", "error", "queue bytes", "queue chunks", "frame cap", "aggregate cap"]) {
  test(`transport observes ${fault} before an ordered consumer unblocks`, timeout, async () => {
    const pipe = new PassThrough();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const terminal = Promise.withResolvers();
    const delivered = [];
    const reader = attachBoundedJsonlReader({
      stream: pipe, label: "test control pipe",
      maxFrameBytes: fault === "queue chunks" ? 4_096 : 32,
      maxAggregateBytes: fault === "aggregate cap" ? 20 : undefined,
      onEnd: () => terminal.resolve("eof"),
      onError: (err) => terminal.resolve(err.message),
      onRecord: async (frame) => {
        delivered.push(frame);
        if (frame === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      pipe.write("1\n");
      await entered.promise;
      if (fault === "eof") pipe.end("2\n3\n");
      else if (fault === "error") pipe.destroy(new Error("injected pipe error"));
      else if (fault === "queue chunks") {
        for (let i = 0; i <= HOST_LIMITS.maxQueuedPipeChunks; i++) pipe.write("\n");
      } else if (fault === "queue bytes") pipe.write("2\n".repeat(17));
      else if (fault === "frame cap") pipe.write("0".repeat(32));
      else pipe.write("2\n".repeat(10));
      const observed = await terminal.promise;
      assert.deepEqual(delivered, [1]);
      assert.equal(pipe.readableLength, 0);
      if (fault === "eof") assert.equal(observed, "eof");
      else if (fault === "error") assert.equal(observed, "injected pipe error");
      else if (fault.startsWith("queue")) assert.match(observed, /ingress queue/);
      else assert.match(observed, /exceeded frame cap/);
      release.resolve();
      const outcome = await reader.done;
      assert.equal(outcome.kind, fault === "eof" ? "drained" : "incomplete");
      assert.deepEqual(delivered, fault === "eof" ? [1, 2, 3] : [1]);
    } finally {
      release.resolve();
      reader.stop();
      await reader.done;
    }
  });
}

test("large RPC frames split across sink writes and retain exactly the cap prefix", timeout, async (t) => {
  const dir = await privateDir(t);
  const cap = 262_144;
  const path = join(dir, "rpc.jsonl");
  const sink = new BoundedRawSink({ path, maxBytes: cap });
  const pipe = new PassThrough();
  const errors = [];
  const received = [];
  const reader = attachBoundedJsonlReader({
    stream: pipe, label: "rpc capture", maxFrameBytes: 524_288, rawSink: sink,
    onError: (err) => errors.push(err.message),
    onRecord: async (frame) => { received.push(frame); },
  });
  const large = "å".repeat(90_000);
  const wire = Buffer.from(JSON.stringify(large) + "\n" + JSON.stringify(large) + "\n");
  try {
    for (let offset = 0; offset < wire.length; offset += 131_072) {
      // Each read owns its backing. The full wire remains with this producer.
      const block = Buffer.allocUnsafeSlow(Math.min(wire.length - offset, 131_072));
      wire.copy(block, 0, offset, offset + block.length);
      pipe.write(block);
    }
    pipe.end();
    assert.equal((await reader.done).kind, "incomplete");
    assert.deepEqual(errors, []);
    assert.deepEqual(received, [large]);
    assert.equal((await sink.close(deadline())).kind, "drained");
    assert.equal(sink.maxPendingObserved, 65_536);
    assert.deepEqual(await readFile(path), wire.subarray(0, cap));
  } finally {
    reader.stop();
    await sink.close(deadline());
  }
});

test("a stalled sink detaches a bounded view from its oversized backing", timeout, async (t) => {
  const dir = await privateDir(t);
  const path = join(dir, "raw");
  const sink = new BoundedRawSink({ path, maxBytes: 65_536 });
  const file = await open(join(dir, "probe"), "wx");
  const prototype = Object.getPrototypeOf(file);
  await file.close();
  const write = prototype.write;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  function submit() {
    const backing = new ArrayBuffer(4 * 1024 * 1024);
    const view = Buffer.from(backing, 128, 65_536).fill(33);
    return { backing: new WeakRef(backing), pending: sink.writeChunk(view) };
  }
  try {
    assert.equal(await sink.ready, true);
    prototype.write = async function (payload, ...args) {
      entered.resolve(payload.buffer.byteLength);
      await release.promise;
      return write.call(this, payload, ...args);
    };
    const { backing, pending } = submit();
    const pendingBacking = await entered.promise;
    for (let i = 0; i < 6; i++) {
      await nextTurn();
      global.gc();
    }
    assert.equal(backing.deref(), undefined, "a pending write retained the caller's full backing");
    assert.equal(pendingBacking, 65_536);
    assert.equal(sink.maxPendingObserved, pendingBacking);
    release.resolve();
    assert.equal((await pending).kind, "written");
    assert.deepEqual(await readFile(path), Buffer.alloc(65_536, 33));

    const tooLarge = new BoundedRawSink({ path: join(dir, "too-large"), maxBytes: 131_072 });
    assert.equal((await tooLarge.writeChunk(Buffer.alloc(65_537))).kind, "failed");
    assert.equal(tooLarge.bytesWritten, 0);
    assert.equal((await tooLarge.close(deadline())).kind, "incomplete");
  } finally {
    release.resolve();
    prototype.write = write;
    await sink.close(deadline());
  }
});

test("index publication cannot replace an existing final entry", timeout, async (t) => {
  const dir = await privateDir(t);
  const path = join(dir, "run.json");
  await publishExclusiveIndex(path, '{"status":"Answered"}');
  await assert.rejects(publishExclusiveIndex(path, '{"status":"InvalidEvidence"}'), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), '{"status":"Answered"}');
});
