"""Unprivileged regression tests: no sudo, real chown, or host paths modified."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "fixture_priv", Path(__file__).with_name("continuum-fixture-priv.py")
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class ChownBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / ".local" / "computer-fixtures"
        self.root.mkdir(parents=True)
        self.child = self.root / "fixture"
        self.child.mkdir()
        self.outside = self.base / "outside"
        self.outside.mkdir()
        self.inode = self.child.stat().st_ino
        self.chown = patch.object(helper.os, "chown", side_effect=AssertionError("path-based chown forbidden"))
        self.chown.start()
        self.addCleanup(self.chown.stop)

    def run_chown(self, path=None, root=None, owner="110123:1000"):
        helper.chown(owner, str(path or self.child), str(root or self.root))

    def test_direct_directory_uses_open_inode(self):
        observed = []
        with patch.object(helper.os, "fchown", side_effect=lambda fd, u, g: observed.append((os.fstat(fd).st_ino, u, g))):
            self.run_chown()
        self.assertEqual(observed, [(self.inode, 110123, 1000)])

    def test_final_symlink_refused(self):
        self.child.rmdir()
        self.child.symlink_to(self.outside, target_is_directory=True)
        with patch.object(helper.os, "fchown") as change, self.assertRaises(SystemExit):
            self.run_chown()
        change.assert_not_called()

    def test_swapped_final_component_before_open_refused(self):
        original_open = os.open
        def racing_open(path, flags, **kwargs):
            if path == "fixture":
                self.child.rename(self.root / "original")
                self.child.symlink_to(self.outside, target_is_directory=True)
            return original_open(path, flags, **kwargs)
        with patch.object(helper.os, "open", side_effect=racing_open), patch.object(helper.os, "fchown") as change, self.assertRaises(SystemExit):
            self.run_chown()
        change.assert_not_called()

    def test_swap_after_open_cannot_redirect_ownership(self):
        observed = []
        def racing_chown(fd, uid, gid):
            self.child.rename(self.root / "original")
            self.child.symlink_to(self.outside, target_is_directory=True)
            observed.append(os.fstat(fd).st_ino)
        with patch.object(helper.os, "fchown", side_effect=racing_chown):
            self.run_chown()
        self.assertEqual(observed, [self.inode])
        self.assertNotEqual(observed[0], self.outside.stat().st_ino)

    def test_ancestor_symlink_refused(self):
        self.root.rename(self.base / "moved-root")
        self.root.symlink_to(self.base / "moved-root", target_is_directory=True)
        with patch.object(helper.os, "fchown") as change, self.assertRaises(SystemExit):
            self.run_chown()
        change.assert_not_called()

    def test_ancestor_swap_after_open_stays_on_original_inode(self):
        original_open = os.open
        def racing_open(path, flags, **kwargs):
            if path == "fixture":
                self.root.rename(self.base / "moved-root")
                self.root.symlink_to(self.outside, target_is_directory=True)
            return original_open(path, flags, **kwargs)
        observed = []
        with patch.object(helper.os, "open", side_effect=racing_open), patch.object(helper.os, "fchown", side_effect=lambda fd, u, g: observed.append(os.fstat(fd).st_ino)):
            self.run_chown()
        self.assertEqual(observed, [self.inode])

    def test_regular_file_refused(self):
        self.child.rmdir()
        self.child.write_text("not a directory")
        with patch.object(helper.os, "fchown") as change, self.assertRaises(SystemExit):
            self.run_chown()
        change.assert_not_called()

    def test_invalid_paths_refused(self):
        for path in (self.outside, self.child / "nested", "relative", str(self.root) + "/../computer-fixtures/fixture", str(self.child) + "\0"):
            with self.subTest(path=str(path)), patch.object(helper.os, "fchown") as change, self.assertRaises(SystemExit):
                self.run_chown(path=path)
            change.assert_not_called()

    def test_invalid_owners_refused(self):
        for owner in ("0:0", "110123:0", "109999:1000", "200000:1000", "110123:65535", "110123:1000\n"):
            with self.subTest(owner=owner), patch.object(helper.os, "fchown") as change, self.assertRaises(SystemExit):
                self.run_chown(owner=owner)
            change.assert_not_called()

    def test_descriptor_cleanup_on_success_and_failure(self):
        before = len(os.listdir("/proc/self/fd"))
        for _ in range(10):
            with patch.object(helper.os, "fchown"):
                self.run_chown()
            with patch.object(helper.os, "fchown", side_effect=OSError("injected")), self.assertRaises(SystemExit):
                self.run_chown()
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)


if __name__ == "__main__":
    unittest.main()
