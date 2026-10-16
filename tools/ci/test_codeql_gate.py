import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("check-codeql-alerts.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def evidence(severity="5.0", level="warning", results=True):
    return {"version": "2.1.0", "runs": [{"tool": {"driver": {"name": "CodeQL", "rules": [
        {"id": "test/rule", "properties": {"security-severity": severity}}]}},
        "results": [{"ruleId": "test/rule", "level": level}] if results else []}]}


class GateTests(unittest.TestCase):
    def test_high_and_critical_block(self):
        for severity in ("7.0", "9.0", "10"):
            self.assertTrue(gate.evaluate(evidence(severity)))

    def test_errors_block(self):
        self.assertTrue(gate.evaluate(evidence("2", "error")))

    def test_medium_is_not_silently_promoted(self):
        self.assertEqual(gate.evaluate(evidence("6.9")), [])

    def test_valid_empty_results(self):
        self.assertEqual(gate.evaluate(evidence(results=False)), [])

    def test_missing_evidence_rejected(self):
        for d in ({}, {"version": "2.1.0", "runs": []}, {"version": "1.0", "runs": [{}]}):
            with self.assertRaises(ValueError):
                gate.evaluate(d)

    def test_unknown_tool_rejected(self):
        d = evidence(); d["runs"][0]["tool"]["driver"]["name"] = "other"
        with self.assertRaises(ValueError):
            gate.evaluate(d)

    def test_missing_results_rejected(self):
        d = evidence(); del d["runs"][0]["results"]
        with self.assertRaises(ValueError):
            gate.evaluate(d)

    def test_failed_invocation_rejected(self):
        d = evidence(); d["runs"][0]["invocations"] = [{"executionSuccessful": False}]
        with self.assertRaises(ValueError):
            gate.evaluate(d)

    def test_execution_error_rejected(self):
        d = evidence(); d["runs"][0]["invocations"] = [{"toolExecutionNotifications": [{"level": "error"}]}]
        with self.assertRaises(ValueError):
            gate.evaluate(d)

    def test_unknown_rule_rejected(self):
        d = evidence(); d["runs"][0]["results"][0]["ruleId"] = "unknown"
        with self.assertRaises(ValueError):
            gate.evaluate(d)

    def test_bad_severity_rejected(self):
        for value in ("NaN", "Infinity", "-1", "11", "garbage"):
            with self.assertRaises(ValueError):
                gate.evaluate(evidence(value))

    def test_suppression_cannot_hide_high_finding(self):
        d = evidence("9"); d["runs"][0]["results"][0]["suppressions"] = [{"status": "accepted"}]
        self.assertTrue(gate.evaluate(d))

    def test_missing_files_rejected(self):
        with self.assertRaises(ValueError):
            gate.main("/nonexistent/continuum-codeql-test/*.sarif")


if __name__ == "__main__":
    unittest.main()
