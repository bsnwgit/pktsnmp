#!/usr/bin/env python3
"""
backup.py — Windows-side 2-rotation backup of pktSNMP project files.

Run from the root of the pktSNMP repo. Zips the entire project (excluding
node_modules, __pycache__, .venv, .git) into a dated archive and keeps the
two most recent copies in the configured destination folder.

Usage:
    python backup.py [--dest D:\Backups\pktSNMP]

Defaults:
    --dest  C:\Users\robert.barnett\My Drive\Backups\pktSNMP
"""

import argparse
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

DEST_DEFAULT = Path.home() / "My Drive" / "Backups" / "pktSNMP"
KEEP = 2

EXCLUDE_DIRS  = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", ".next"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}


def make_archive(src: Path, dest: Path) -> Path:
    stamp    = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = dest / f"pktSNMP_{stamp}.zip"
    dest.mkdir(parents=True, exist_ok=True)
    print(f"Creating {filename} …")
    with zipfile.ZipFile(filename, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(src):
            # Prune excluded directories in-place
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for file in files:
                if file in EXCLUDE_FILES:
                    continue
                full = Path(root) / file
                arcname = full.relative_to(src)
                zf.write(full, arcname)
    size_mb = filename.stat().st_size / 1024 / 1024
    print(f"  → {size_mb:.1f} MB")
    return filename


def rotate(dest: Path):
    pattern = re.compile(r"^pktSNMP_\d{8}_\d{6}\.zip$")
    archives = sorted(
        [p for p in dest.iterdir() if p.is_file() and pattern.match(p.name)],
        key=lambda p: p.stat().st_mtime,
    )
    while len(archives) > KEEP:
        old = archives.pop(0)
        print(f"  Removing old backup: {old.name}")
        old.unlink()


def main():
    parser = argparse.ArgumentParser(description="pktSNMP Windows backup (2 rotation)")
    parser.add_argument("--dest", type=Path, default=DEST_DEFAULT, help="Destination folder")
    args = parser.parse_args()

    src = Path(__file__).resolve().parent
    if not (src / "app").is_dir():
        print(f"ERROR: run this from the pktSNMP repo root (got: {src})", file=sys.stderr)
        sys.exit(1)

    archive = make_archive(src, args.dest)
    rotate(args.dest)

    # List remaining backups
    remaining = sorted(args.dest.glob("pktSNMP_*.zip"))
    print(f"\nBackups in {args.dest}:")
    for p in remaining:
        print(f"  {p.name}  ({p.stat().st_size / 1024 / 1024:.1f} MB)")
    print("\nDone.")


if __name__ == "__main__":
    main()
