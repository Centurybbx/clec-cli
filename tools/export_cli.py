#!/usr/bin/env python3
"""Copy the public CLI source allowlist to an existing standalone checkout."""
import argparse
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1] / 'cli'
destination = args.destination.resolve(strict=True)
origin = subprocess.check_output(['git', '-C', str(destination), 'remote', 'get-url', 'origin'], text=True).strip()
if origin not in ('git@github.com:Centurybbx/clec-cli.git', 'https://github.com/Centurybbx/clec-cli.git'):
    parser.error('destination must be the Centurybbx/clec-cli checkout')
if subprocess.check_output(['git', '-C', str(destination), 'status', '--porcelain'], text=True).strip():
    parser.error('destination has changes; review them before replacing public sources')
files = [source / name for name in ('.gitignore', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json')]
for directory, pattern in (('src', '*.ts'), ('test', '*.mjs'), ('docs', '*.md'), ('.github/workflows', '*.yml')):
    files.extend((source / directory).glob(pattern))
for path in sorted(files):
    if path.is_symlink() or not path.is_file():
        parser.error(f'not a regular public file: {path}')
    target = destination / path.relative_to(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, target)
    print(path.relative_to(source))
