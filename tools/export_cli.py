#!/usr/bin/env python3
"""Export the Stage 6A native source, packaging, Skill, and workflow allowlist into a fresh directory."""
import argparse
from pathlib import Path
import shutil


def collect_allowlist(repo_root: Path) -> list[Path]:
    files: list[Path] = [
        repo_root / '.gitignore',
        repo_root / 'README.md',
        repo_root / '.github' / 'workflows' / 'ci.yml',
        repo_root / 'native' / 'Cargo.toml',
        repo_root / 'native' / 'Cargo.lock',
        repo_root / 'cli' / '.gitignore',
        repo_root / 'cli' / 'README.md',
        repo_root / 'cli' / 'NOTICES.md',
        repo_root / 'cli' / 'package.json',
        repo_root / 'cli' / 'bin' / 'clec.exe',
        repo_root / 'cli' / 'docs' / 'agent-guide.md',
        repo_root / 'cli' / 'skills' / 'clec' / 'SKILL.md',
    ]
    for root_dir, pattern in (
        (repo_root / 'native' / 'src', '*.rs'),
        (repo_root / 'native' / 'examples', '*.rs'),
        (repo_root / 'native' / 'tests', '*.rs'),
        (repo_root / 'cli' / 'scripts', '*.mjs'),
        (repo_root / 'cli' / 'test', '*.test.mjs'),
    ):
        if root_dir.exists():
            files.extend(p for p in root_dir.rglob(pattern))
    return sorted(set(files))


def export_allowlist(repo_root: Path, destination: Path) -> list[str]:
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise SystemExit(f'destination exists and is not a regular directory: {destination}')
        if any(destination.iterdir()):
            raise SystemExit(f'destination directory must be empty: {destination}')
    else:
        destination.mkdir(parents=True, exist_ok=True)

    exported: list[str] = []
    for src in collect_allowlist(repo_root):
        if src.is_symlink() or not src.is_file():
            raise SystemExit(f'allowlist path is not a regular non-symlink file: {src}')
        rel = src.relative_to(repo_root)
        dst = destination / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        exported.append(rel.as_posix())
    return exported


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path, help='Fresh empty or non-existent staging directory')
    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    exported = export_allowlist(repo_root, args.destination.resolve())
    for rel in exported:
        print(rel)


if __name__ == '__main__':
    main()
