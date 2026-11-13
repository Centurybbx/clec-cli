#!/usr/bin/env python3
"""Exercise real sync transfers and failed-update preservation.

Usage: transfer.py CLEC DATA_DIR SAMPLE_RELEASE UPDATE_RELEASE OUTPUT.json
The two release directories contain publisher-built manifest.json and corpus.sqlite.
Run with disposable DATA_DIR. The sample is activated before negative cases.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time

cli, data, sample, update, output = sys.argv[1:]
data, sample, update = map(Path, (data, sample, update))
env = {k: v for k, v in os.environ.items() if not any(x in k.upper() for x in ('API_KEY', 'TOKEN', 'SECRET'))}
results = []
monitor_stop = threading.Event()
metrics = {'peak_data_bytes': 0, 'minimum_free_bytes': None, 'sample_interval_seconds': 0.25}
def monitor():
    while not monitor_stop.is_set():
        files = list(data.rglob('*')) if data.exists() else []
        total = 0
        for file in files:
            try:
                if file.is_file(): total += file.stat().st_size
            except FileNotFoundError:
                pass
        stat = os.statvfs(data.parent)
        available = stat.f_bavail * stat.f_frsize
        metrics['peak_data_bytes'] = max(metrics['peak_data_bytes'], total)
        metrics['minimum_free_bytes'] = min(metrics['minimum_free_bytes'] or available, available)
        monitor_stop.wait(0.25)
threading.Thread(target=monitor, daemon=True).start()

def call(*args):
    try:
        p = subprocess.run([cli, *args, '--data-dir', str(data)], capture_output=True, text=True, env=env, timeout=600)
    except subprocess.TimeoutExpired:
        result = {'args': args, 'timeout': True}
        results.append(result)
        return result
    try:
        value = json.loads(p.stdout)
    except json.JSONDecodeError:
        value = None
    result = {'args': args, 'exit': p.returncode, 'json': value, 'stdout': p.stdout if value is None else None, 'stderr': p.stderr}
    results.append(result)
    return result

def success(result):
    assert result['exit'] == 0 and result['json'] and result['json'].get('ok') is True, result

def failure(result):
    assert result['exit'] != 0 and result['json'] and result['json'].get('ok') is False, result

class Handler(BaseHTTPRequestHandler):
    mode = 'normal'
    paths = []
    def do_GET(self):
        self.paths.append(self.path)
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/manifest.json')
            self.end_headers()
            return
        file = update / ('manifest.json' if self.path == '/manifest.json' else 'corpus.sqlite')
        if self.path not in ('/manifest.json', '/corpus.sqlite'):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(file.stat().st_size))
        self.end_headers()
        with file.open('rb') as source:
            if file.name == 'corpus.sqlite' and self.mode == 'abort':
                self.wfile.write(source.read(1024))
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            elif file.name == 'corpus.sqlite' and self.mode == 'corrupt':
                chunk = source.read(65536)
                if chunk:
                    self.wfile.write(bytes([chunk[0] ^ 1]) + chunk[1:])
                shutil.copyfileobj(source, self.wfile)
            else:
                shutil.copyfileobj(source, self.wfile)
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/manifest.json'
try:
    success(call('sync', '--manifest', str(sample / 'manifest.json')))
    old = call('status'); success(old)
    old_release = old['json']['release']
    for mode in ('corrupt', 'abort'):
        Handler.mode = mode
        failure(call('sync', '--manifest', url))
        status = call('status'); success(status)
        assert status['json']['release'] == old_release, status
    Handler.mode = 'normal'
    success(call('sync', '--manifest', url))
    current = call('status'); success(current)
    Handler.paths.clear()
    success(call('sync', '--manifest', url.replace('/manifest.json', '/redirect')))
    assert '/redirect' in Handler.paths and '/manifest.json' in Handler.paths and '/corpus.sqlite' not in Handler.paths, Handler.paths
    again = call('status'); success(again)
    assert current['json']['release'] == again['json']['release']
    assert current['json']['managedBytes'] == again['json']['managedBytes']
finally:
    server.shutdown()
    monitor_stop.set()
    Path(output).write_text(json.dumps({'calls': results, 'metrics': metrics, 'last_http_paths': Handler.paths}, ensure_ascii=False, indent=2) + '\n')
