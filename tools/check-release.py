import json, sys
from pathlib import Path
Path(".artifacts/core").mkdir(parents=True, exist_ok=True)
REQUIRED = [f"G{i}" for i in range(1, 13)]
ALLOWED = {"PASS_PRODUCTION", "PARTIAL", "NOT_RUN", "FAIL"}

def malformed(message):
    print(json.dumps({"malformed": True, "error": message, "canonPromotionAllowed": False}))
    sys.exit(1)

x = json.loads(Path("docs/RELEASE-GATES.json").read_text())
gates = x.get("gates")
if not isinstance(gates, list) or not gates:
    malformed("missing gates")
ids = [g.get("id") for g in gates if isinstance(g, dict)]
if len(ids) != len(gates) or any(not isinstance(i, str) or not i for i in ids):
    malformed("gate id")
if len(ids) != len(set(ids)) or set(ids) != set(REQUIRED):
    malformed("gate set")
if any(g.get("status") not in ALLOWED for g in gates):
    malformed("status")
if x.get("schedulerDecision") != "HELD — both pass bounded workload; required long-wait/production burden tests incomplete":
    malformed("scheduler")
blocked = [g["id"] for g in gates if g["status"] != "PASS_PRODUCTION"]
blocked.append("scheduler")
result = {"productionReady": not blocked, "canonPromotionAllowed": not blocked, "blockedGates": blocked, "schedulerDecision": x["schedulerDecision"]}
Path(".artifacts/core/RELEASE-STATUS.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
if "--enforce" in sys.argv and blocked:
    sys.exit(1)
