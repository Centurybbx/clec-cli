#!/usr/bin/env python3
"""Run one read-only CLI call within a persistent per-case budget.

Private configuration is ~/.cache/clec/runs/cli-product-20261113/evaluation/broker-config.json
with absolute paths named cli, data_dir, and run_dir. Usage:
  python3 broker.py --run-dir RUN_DIR CASE_ID COMMAND [ARG ...]
The agent must have no other access to the CLI, corpus, case logs, or gold. This
broker is not an OS sandbox; enforcement depends on that external restriction.
Output limits count raw CLI stdout and stderr bytes before JSON encoding.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time

CONFIG = Path.home() / '.cache/clec/runs/cli-product-20261113/evaluation/broker-config.json'
MAX_CALLS, MAX_BYTES, MAX_SECONDS = 12, 256 * 1024, 180


def save(path, value):
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.state-')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def log(path, event):
    with path.open('a') as f:
        f.write(json.dumps(event, ensure_ascii=True) + '\n')
        f.flush()
        os.fsync(f.fileno())


def run(argv, data_dir, allowance, deadline):
    started = time.time()
    chunks = {'stdout': bytearray(), 'stderr': bytearray()}
    reason = None
    exit_code = None
    try:
        env = os.environ.copy()
        env['CLEC_DATA_DIR'] = str(data_dir)
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=env, start_new_session=True)
        selector = selectors.DefaultSelector()
        for name in chunks:
            stream = getattr(process, name)
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        remaining = allowance
        while selector.get_map():
            wait = deadline - time.time()
            if wait <= 0:
                reason = 'time_limit'
                break
            for key, _ in selector.select(min(wait, 0.25)):
                block = os.read(key.fileobj.fileno(), min(65536, remaining + 1))
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                chunks[key.data].extend(block[:remaining])
                if len(block) > remaining:
                    reason = 'output_limit'
                    break
                remaining -= len(block)
            if reason:
                break
        if reason:
            os.killpg(process.pid, signal.SIGKILL)
        else:
            try:
                process.wait(timeout=max(0, deadline - time.time()))
            except subprocess.TimeoutExpired:
                reason = 'time_limit'
                os.killpg(process.pid, signal.SIGKILL)
        exit_code = process.wait()
        selector.close()
        process.stdout.close()
        process.stderr.close()
    except OSError as exc:
        reason = 'spawn_error'
        message = str(exc).encode()[:allowance]
        chunks['stderr'].extend(message)
    ended = time.time()
    return {'started': started, 'ended': ended, 'exit': exit_code, 'reason': reason,
            'stdout': chunks['stdout'].decode('utf-8', errors='replace'),
            'stderr': chunks['stderr'].decode('utf-8', errors='replace'),
            'stdout_bytes': len(chunks['stdout']), 'stderr_bytes': len(chunks['stderr'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True)
    parser.add_argument('case_id')
    parser.add_argument('cli_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    cli, data_dir, run_dir = (Path(config[key]).resolve(strict=True) for key in ('cli', 'data_dir', 'run_dir'))
    if Path(args.run_dir).resolve(strict=True) != run_dir:
        parser.error('run directory does not match private configuration')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.case_id):
        parser.error('invalid case ID')
    case_dir = run_dir / args.case_id
    case_dir.mkdir(mode=0o700, exist_ok=True)
    state_path, log_path = case_dir / 'state.json', case_dir / 'calls.jsonl'
    with (case_dir / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = time.time()
        state = json.loads(state_path.read_text()) if state_path.exists() else {'first': now, 'calls': 0, 'bytes': 0}
        cmd = args.cli_args
        denial = None
        if not cmd or 'sync' in cmd or any(x == '--data-dir' or x.startswith('--data-dir=') for x in cmd):
            denial = 'read-only commands only; data directory is fixed'
        elif state['calls'] >= MAX_CALLS:
            denial = 'call_limit'
        elif state['bytes'] >= MAX_BYTES:
            denial = 'output_limit'
        elif now >= state['first'] + MAX_SECONDS:
            denial = 'time_limit'
        if denial:
            event = {'event': 'denied', 'time': now, 'args': cmd, 'reason': denial}
            log(log_path, event)
            print(json.dumps(event))
            return 2
        remaining = MAX_BYTES - state['bytes']
        state['calls'] += 1
        state['bytes'] = MAX_BYTES
        save(state_path, state)
        log(log_path, {'event': 'start', 'time': now, 'args': cmd, 'call': state['calls'], 'reserved_bytes': remaining})
        result = run([str(cli), '--data-dir', str(data_dir), *cmd], data_dir, remaining, state['first'] + MAX_SECONDS)
        state['bytes'] -= remaining - result['stdout_bytes'] - result['stderr_bytes']
        save(state_path, state)
        event = {'event': 'finish', 'args': cmd, 'call': state['calls'], **result}
        log(log_path, event)
        print(json.dumps(event, ensure_ascii=True))
        return 0 if result['exit'] == 0 and result['reason'] is None else 1


if __name__ == '__main__':
    sys.exit(main())
