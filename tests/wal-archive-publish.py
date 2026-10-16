"""A killed archive copy must not leave a short WAL segment under its final name."""
import os
import tempfile
from pathlib import Path

import importlib.util

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "wal_archive", root / "tools" / "wal-archive.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_complete_publish_matches_source():
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        source = base / "segment"
        source.write_bytes(b"a" * 64)
        dest = base / "archive" / "000000010000000000000004"
        dest.parent.mkdir()
        module.publish(source, dest)
        assert dest.read_bytes() == source.read_bytes()
        assert not (dest.parent / ".000000010000000000000004.partial").exists()


def test_failed_copy_does_not_publish_a_short_segment():
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        source = base / "segment"
        source.write_bytes(b"a" * 64)
        dest = base / "000000010000000000000005"
        real_open = Path.open

        def interrupted(self, mode="r", *args, **kwargs):
            if self == dest.with_name("." + dest.name + ".partial") and "w" in mode:
                handle = real_open(self, mode, *args, **kwargs)
                handle.write(b"short")
                handle.close()
                raise RuntimeError("archive command killed")
            return real_open(self, mode, *args, **kwargs)

        Path.open = interrupted
        try:
            try:
                module.publish(source, dest)
            except RuntimeError as e:
                assert str(e) == "archive command killed"
            else:
                raise AssertionError("interrupted publish returned success")
        finally:
            Path.open = real_open
        assert not dest.exists()
        assert not dest.with_name("." + dest.name + ".partial").exists()


def test_same_size_mismatch_is_not_left_archived():
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        source = base / "segment"
        source.write_bytes(b"a" * 32)
        dest = base / "000000010000000000000005"
        dest.write_bytes(b"b" * 32)
        module.publish(source, dest)
        assert dest.read_bytes() == source.read_bytes()


def test_publish_fsyncs_the_destination_directory():
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        source = base / "segment"
        source.write_bytes(b"a" * 32)
        dest = base / "archive" / "000000010000000000000004"
        dest.parent.mkdir()
        opened = []
        fsynced = []
        real_open = os.open
        real_fsync = os.fsync

        def tracking_open(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            opened.append((Path(path), flags, fd))
            return fd

        def tracking_fsync(fd):
            fsynced.append(fd)
            return real_fsync(fd)

        os.open = tracking_open
        os.fsync = tracking_fsync
        try:
            module.publish(source, dest)
        finally:
            os.open = real_open
            os.fsync = real_fsync
        directory_fds = {
            fd
            for path, flags, fd in opened
            if path == dest.parent and flags & os.O_DIRECTORY
        }
        assert directory_fds & set(fsynced)
        assert dest.read_bytes() == source.read_bytes()


def test_existing_short_file_is_not_treated_as_archived():
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        source = base / "segment"
        payload = os.urandom(32)
        source.write_bytes(payload)
        dest = base / "000000010000000000000005"
        dest.write_bytes(b"short")
        module.publish(source, dest)
        assert dest.read_bytes() == payload


if __name__ == "__main__":
    test_complete_publish_matches_source()
    test_failed_copy_does_not_publish_a_short_segment()
    test_same_size_mismatch_is_not_left_archived()
    test_publish_fsyncs_the_destination_directory()
    test_existing_short_file_is_not_treated_as_archived()
    print("wal-archive-publish ok")
