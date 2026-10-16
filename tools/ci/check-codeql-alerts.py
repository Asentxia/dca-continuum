#!/usr/bin/env python3
"""Evaluate complete local CodeQL SARIF without overriding org-managed default setup."""
from decimal import Decimal, InvalidOperation
import glob
import json
from pathlib import Path
import subprocess
import sys


def evaluate(document):
    if document.get("version") != "2.1.0" or not document.get("runs"):
        raise ValueError("Missing or unsupported SARIF evidence")
    blockers = []
    for run in document["runs"]:
        driver = run.get("tool", {}).get("driver", {})
        if driver.get("name") != "CodeQL" or not isinstance(run.get("results"), list):
            raise ValueError("Missing CodeQL result set")
        for invocation in run.get("invocations", []):
            if invocation.get("executionSuccessful") is False:
                raise ValueError("CodeQL execution failed")
            if any(n.get("level") == "error" for n in invocation.get("toolExecutionNotifications", [])):
                raise ValueError("CodeQL reported an execution error")
        rules = {rule["id"]: rule for rule in driver.get("rules", [])}
        for result in run["results"]:
            rule_id = result.get("ruleId")
            if rule_id not in rules:
                raise ValueError("Result references an unknown rule")
            rule = rules[rule_id]
            level = result.get("level", rule.get("defaultConfiguration", {}).get("level", "warning"))
            severity = rule.get("properties", {}).get("security-severity")
            high = False
            if severity is not None:
                try:
                    numeric = Decimal(str(severity))
                    if not numeric.is_finite() or not Decimal(0) <= numeric <= Decimal(10):
                        raise ValueError("Invalid security severity")
                    high = numeric >= Decimal(7)
                except InvalidOperation as error:
                    raise ValueError("Invalid security severity") from error
            if high or level == "error":
                # Do not automatically honor suppressions in untrusted source/SARIF.
                blockers.append({"rule": rule_id, "level": level, "security_severity": severity})
    return blockers


def main(pattern):
    files = sorted(glob.glob(pattern))
    if not files:
        raise ValueError("No CodeQL SARIF files; cannot claim a pass")
    blockers = []
    for filename in files:
        blockers.extend(evaluate(json.loads(Path(filename).read_text())))
    print(json.dumps({"tested_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
                      "sarif_files": len(files), "blocking_findings": blockers, "complete": True}))
    return 1 if blockers else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
