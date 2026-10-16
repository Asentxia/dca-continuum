#!/usr/bin/env python3
"""Publish one complete WAL segment. A partial copy never keeps the final name."""
import filecmp
import os
import shutil
import sys
from pathlib import Path


def fsync_directory(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(source: Path, dest: Path) -> None:
    source = Path(source)
    dest = Path(dest)
    size = source.stat().st_size
    if dest.exists() and dest.stat().st_size == size and filecmp.cmp(source, dest, shallow=False):
        fsync_directory(dest.parent)
        return
    if dest.exists():
        dest.unlink()
    tmp = dest.with_name("." + dest.name + ".partial")
    try:
        with source.open("rb") as incoming, tmp.open("wb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        if tmp.stat().st_size != size:
            raise RuntimeError("partial archive refused")
        os.replace(tmp, dest)
        fsync_directory(dest.parent)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(2)
    publish(Path(sys.argv[1]), Path(sys.argv[2]))


if __name__ == "__main__":
    main()
