import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("check-codeql-alerts.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def evidence(self, error="", sha="tested"):
        return [{"commit_sha": sha, "category": "/language:" + language, "error": error}
                for language in ("javascript-typescript", "python", "actions")]

    def test_stale_commit_rejected(self):
        with self.assertRaises(ValueError):
            gate.validate_analyses(self.evidence(sha="older"), "tested")

    def test_missing_language_rejected(self):
        with self.assertRaises(ValueError):
            gate.validate_analyses(self.evidence()[:2], "tested")

    def test_missing_evidence_rejected(self):
        for value in ([], None, {}):
            with self.assertRaises(ValueError):
                gate.validate_analyses(value, "tested")

    def test_analysis_error_rejected(self):
        with self.assertRaises(ValueError):
            gate.validate_analyses(self.evidence(error="analysis failed"), "tested")

    def test_analysis_success(self):
        gate.validate_analyses(self.evidence(), "tested")

    def test_high_critical_and_errors_block(self):
        for rule in ({"security_severity_level": "critical"}, {"security_severity_level": "high"}, {"severity": "error"}):
            self.assertTrue(gate.blocking({"rule": rule}))

    def test_lower_severity_not_silently_promoted(self):
        self.assertFalse(gate.blocking({"rule": {"security_severity_level": "medium", "severity": "warning"}}))


if __name__ == "__main__":
    unittest.main()
