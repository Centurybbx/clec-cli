#!/usr/bin/env python3
"""Usage: redirects.py CLEC SAMPLE_RELEASE OUTPUT_DIRECTORY"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import threading

cli, release, output = sys.argv[1:]
release, output = Path(release), Path(output)
output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((release / 'manifest.json').read_text())
requests = []
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append(self.path)
        if self.path in ('/latest/manifest.json', '/external/latest.json'):
            self.send_response(302)
            self.send_header('Location', '/releases/v1/manifest.json' if self.path.startswith('/latest') else '/releases/v1/external.json')
            self.end_headers()
            return
        if self.path in ('/releases/v1/manifest.json', '/releases/v1/external.json'):
            value = dict(manifest)
            if self.path.endswith('external.json'):
                value['artifactUrl'] = f'http://127.0.0.1:{self.server.server_port}/assets/corpus?signature=example'
            data = json.dumps(value).encode()
        elif self.path in ('/releases/v1/corpus.sqlite', '/assets/corpus?signature=example'):
            data = (release / 'corpus.sqlite').read_bytes()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *_):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
results = []
try:
    for name, urlpath, artifact_path in [('relative', '/latest/manifest.json', '/releases/v1/corpus.sqlite'), ('external', '/external/latest.json', '/assets/corpus?signature=example')]:
        requests.clear()
        p = subprocess.run([cli, 'sync', '--manifest', f'http://127.0.0.1:{server.server_port}{urlpath}', '--data-dir', str(output/name)], capture_output=True, text=True, timeout=60)
        result = {'case': name, 'exit': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr, 'requests': list(requests)}
        results.append(result)
        assert p.returncode == 0 and json.loads(p.stdout)['ok'] and artifact_path in requests, result
finally:
    server.shutdown()
    (output/'results.json').write_text(json.dumps(results, indent=2) + '\n')
