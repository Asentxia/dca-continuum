"""The main-push verifier reuses pull-request evidence only for an identical tree."""
import subprocess
import tempfile
from pathlib import Path

import importlib.util

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "main_merge_evidence", root / "tools" / "main-merge-evidence.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(directory, *args):
    subprocess.run(
        ["git", "-C", str(directory), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def commit(directory, name, body):
    path = directory / name
    path.write_text(body, encoding="utf-8")
    git(directory, "add", name)
    subprocess.run(
        [
            "git",
            "-C",
            str(directory),
            "-c",
            "user.name=eng006",
            "-c",
            "user.email=eng006@example.invalid",
            "commit",
            "-m",
            name,
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return subprocess.check_output(
        ["git", "-C", str(directory), "rev-parse", "HEAD"], text=True
    ).strip()


def init_repository():
    directory = Path(tempfile.mkdtemp())
    git(directory, "init", "-q", "-b", "main")
    # The merge commit needs an author. CI runners have no global identity.
    git(directory, "config", "user.name", "eng006")
    git(directory, "config", "user.email", "eng006@example.invalid")
    return directory


def repository():
    directory = init_repository()
    base = commit(directory, "base.txt", "base")
    git(directory, "checkout", "-q", "-b", "change")
    change = commit(directory, "change.txt", "change")
    git(directory, "checkout", "-q", "main")
    git(directory, "merge", "--no-ff", "-m", "merge", "change")
    merged = subprocess.check_output(
        ["git", "-C", str(directory), "rev-parse", "HEAD"], text=True
    ).strip()
    return directory, base, change, merged


def success(name, url):
    return {
        "name": name,
        "conclusion": "success",
        "completed_at": "2026-10-10T00:00:00Z",
        "details_url": url,
        "app": {"slug": "github-actions"},
        "pull_requests": [{"number": 1}],
    }


def test_identical_merge_reuses_successful_checks():
    directory, _base, change, merged = repository()
    decision = module.decide(
        directory,
        merged,
        [
            success("Canonical local verification", "https://example.invalid/canonical"),
            success("Secret scan", "https://example.invalid/secret"),
        ],
    )
    assert decision["mode"] == "reuse"
    assert decision["tested"] == change
    assert decision["canonical"] == "https://example.invalid/canonical"
    assert decision["secret"] == "https://example.invalid/secret"


def test_checks_outside_the_pull_request_are_not_reused():
    directory, _base, _change, merged = repository()
    unrelated = success("Canonical local verification", "https://example.invalid/canonical")
    unrelated["pull_requests"] = []
    other_app = success("Secret scan", "https://example.invalid/secret")
    other_app["app"] = {"slug": "someone-else"}
    decision = module.decide(directory, merged, [unrelated, other_app])
    assert decision["mode"] == "full"
    assert decision["reason"] == "required pull request evidence is missing"


def test_missing_or_failed_evidence_requires_full_verification():
    directory, _base, _change, merged = repository()
    assert module.decide(directory, merged, [])["mode"] == "full"
    failed = module.decide(
        directory,
        merged,
        [
            {
                "name": "Canonical local verification",
                "conclusion": "failure",
                "completed_at": "2026-10-10T00:00:02Z",
            },
            success("Secret scan", "https://example.invalid/secret"),
            {
                "name": "Canonical local verification",
                "conclusion": "success",
                "completed_at": "2026-10-10T00:00:01Z",
            },
        ],
    )
    assert failed["mode"] == "full"


def test_a_merge_that_changes_the_tested_tree_is_not_reused():
    directory = init_repository()
    commit(directory, "base.txt", "base")
    git(directory, "checkout", "-q", "-b", "change")
    commit(directory, "change.txt", "change")
    git(directory, "checkout", "-q", "main")
    commit(directory, "main-only.txt", "later")
    git(directory, "merge", "--no-ff", "-m", "merge", "change")
    merged = subprocess.check_output(
        ["git", "-C", str(directory), "rev-parse", "HEAD"], text=True
    ).strip()
    decision = module.decide(
        directory,
        merged,
        [
            success("Canonical local verification", "https://example.invalid/canonical"),
            success("Secret scan", "https://example.invalid/secret"),
        ],
    )
    assert decision["mode"] == "full"
    assert decision["reason"] == "merge result differs from the tested pull request"


def test_this_repository_recognizes_identical_and_divergent_merges():
    commits = (
        "a711861fb1240e4269628853e33a84439530f693",
        "ffef6105cd309b2a15f217fe97e094654180861f",
        "dc5f5b34cdacb34b66ff9e784d3d55b43f149189",
    )
    if any(module.git(root, "cat-file", "-e", sha).returncode != 0 for sha in commits):
        return
    identical = module.decide(
        root,
        "a711861fb1240e4269628853e33a84439530f693",
        [
            success("Canonical local verification", "https://example.invalid/canonical"),
            success("Secret scan", "https://example.invalid/secret"),
        ],
    )
    assert identical["mode"] == "reuse"
    assert identical["tested"] == "ffef6105cd309b2a15f217fe97e094654180861f"
    divergent = module.decide(
        root,
        "dc5f5b34cdacb34b66ff9e784d3d55b43f149189",
        [
            success("Canonical local verification", "https://example.invalid/canonical"),
            success("Secret scan", "https://example.invalid/secret"),
        ],
    )
    assert divergent["mode"] == "full"
    assert divergent["reason"] == "merge result differs from the tested pull request"


if __name__ == "__main__":
    test_identical_merge_reuses_successful_checks()
    test_missing_or_failed_evidence_requires_full_verification()
    test_a_merge_that_changes_the_tested_tree_is_not_reused()
    test_this_repository_recognizes_identical_and_divergent_merges()
    print("main-merge-evidence ok")
