#!/usr/bin/env python3
"""Choose reuse or full verification for a commit pushed to main."""
import json
import os
import subprocess
import sys
import urllib.request


REQUIRED = ("Canonical local verification", "Secret scan")


def git(cwd, *args):
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def parents(cwd, sha):
    result = git(cwd, "rev-list", "--parents", "-n", "1", sha)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git parents failed")
    return result.stdout.split()[1:]


def same_tree(cwd, left, right):
    return git(cwd, "diff", "--quiet", left, right).returncode == 0


def from_pull_request(item, name):
    app = item.get("app") or {}
    return (
        item.get("name") == name
        and item.get("conclusion") == "success"
        and item.get("completed_at")
        and app.get("slug") == "github-actions"
        and bool(item.get("pull_requests"))
    )


def latest(checks, name):
    found = [item for item in checks if from_pull_request(item, name)]
    if not found:
        return None
    return max(found, key=lambda item: item["completed_at"])


def decide(cwd, sha, checks):
    found = parents(cwd, sha)
    if len(found) != 2:
        return {"mode": "full", "reason": "not a two-parent merge"}
    tested = found[1]
    if not same_tree(cwd, tested, sha):
        return {
            "mode": "full",
            "reason": "merge result differs from the tested pull request",
            "tested": tested,
        }
    evidence = {}
    for name in REQUIRED:
        item = latest(checks, name)
        if not item or item.get("conclusion") != "success":
            return {
                "mode": "full",
                "reason": "required pull request evidence is missing",
                "tested": tested,
            }
        evidence[name] = item.get("details_url") or item.get("html_url") or ""
    return {
        "mode": "reuse",
        "reason": "merged tree matches the tested pull request",
        "tested": tested,
        "canonical": evidence["Canonical local verification"],
        "secret": evidence["Secret scan"],
    }


def fetch_checks(repository, sha, token):
    checks = []
    page = 1
    while page <= 10:
        request = urllib.request.Request(
            f"https://api.github.com/repos/{repository}/commits/{sha}/check-runs?per_page=100&page={page}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "continuum-main-verification",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.load(response)
        batch = body.get("check_runs") or []
        checks.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return checks


def write_output(path, decision):
    with open(path, "a", encoding="utf-8") as handle:
        for key in ("mode", "reason", "tested", "canonical", "secret"):
            value = decision.get(key, "")
            handle.write(f"{key}<<CONTINUUM_EVIDENCE\n{value}\nCONTINUUM_EVIDENCE\n")


def main():
    cwd = os.getcwd()
    sha = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GITHUB_SHA", "HEAD")
    sha = git(cwd, "rev-parse", sha).stdout.strip()
    preliminary = decide(cwd, sha, [])
    checks = []
    if preliminary.get("tested") and os.environ.get("GITHUB_REPOSITORY") and os.environ.get("GH_TOKEN"):
        checks = fetch_checks(os.environ["GITHUB_REPOSITORY"], preliminary["tested"], os.environ["GH_TOKEN"])
    decision = decide(cwd, sha, checks)
    print(json.dumps(decision))
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        write_output(output, decision)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
