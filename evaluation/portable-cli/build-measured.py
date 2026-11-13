#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time

cli_dir, workspace, intake, release, report = sys.argv[1:]
release = Path(release)
staging = release.parent / ('.' + release.name + '.building')
def size(path):
    return sum(p.stat().st_size for p in path.rglob('*') if p.is_file()) if path.exists() else 0
def free():
    s = os.statvfs(release.parent)
    return s.f_bavail * s.f_frsize

start = time.monotonic()
initial = free()
p = subprocess.Popen(['npm', 'run', 'build:corpus', '--', '--workspace', workspace, '--intake', intake, '--output', str(release)], cwd=cli_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
peak = 0
minimum = initial
while p.poll() is None:
    peak = max(peak, size(staging) + size(release))
    minimum = min(minimum, free())
    time.sleep(1)
stdout, stderr = p.communicate()
peak = max(peak, size(staging) + size(release))
minimum = min(minimum, free())
result = {'exit': p.returncode, 'elapsed_seconds': time.monotonic() - start, 'initial_free_bytes': initial,
          'minimum_sampled_free_bytes': minimum, 'final_free_bytes': free(), 'peak_sampled_release_and_staging_bytes': peak,
          'final_release_bytes': size(release), 'sample_interval_seconds': 1, 'stdout': stdout, 'stderr': stderr}
Path(report).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
sys.exit(p.returncode)
