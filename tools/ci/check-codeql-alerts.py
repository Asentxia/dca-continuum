#!/usr/bin/env python3
"""Fail closed unless the tested ref has processed CodeQL evidence and no blockers."""
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


def blocking(alert):
    rule = alert.get("rule") or {}
    return rule.get("security_severity_level") in {"high", "critical"} or rule.get("severity") == "error"


def validate_analyses(items, expected_sha):
    if not isinstance(items, list) or not items:
        raise ValueError("No processed CodeQL analysis for the tested ref")
    items = [item for item in items if item.get("commit_sha") == expected_sha]
    expected = {"/language:javascript-typescript", "/language:python", "/language:actions"}
    if not expected.issubset({item.get("category") for item in items}):
        raise ValueError("Missing language evidence for the exact tested commit")
    if any(item.get("error") for item in items):
        raise ValueError("CodeQL analysis reported an error")


def main():
    repository = os.environ["GITHUB_REPOSITORY"]
    if repository != "Asentxia/dca-continuum":
        raise ValueError("Unexpected repository")
    ref = os.environ["TESTED_REF"]
    token = os.environ["GH_TOKEN"]

    def get(kind, params):
        url = f"https://api.github.com/repos/{repository}/code-scanning/{kind}?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "continuum-codeql-gate",
        })
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    for attempt in range(6):
        try:
            analyses = get("analyses", {"ref": ref, "tool_name": "CodeQL", "per_page": 100})
            validate_analyses(analyses, subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip())
            break
        except (urllib.error.HTTPError, ValueError):
            if attempt == 5:
                raise
            time.sleep(10)
    blockers = []
    for page in range(1, 21):
        alerts = get("alerts", {"ref": ref, "tool_name": "CodeQL", "state": "open", "per_page": 100, "page": page})
        if not isinstance(alerts, list):
            raise ValueError("Invalid alert result")
        blockers.extend(item["number"] for item in alerts if blocking(item))
        if len(alerts) < 100:
            break
    else:
        raise ValueError("Alert pagination exceeded limit; cannot claim complete review")
    print(json.dumps({"tested_ref": ref, "blocking_alert_numbers": blockers, "complete": True}))
    return 1 if blockers else 0


if __name__ == "__main__":
    raise SystemExit(main())
