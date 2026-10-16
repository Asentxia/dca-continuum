from pathlib import Path
import json, sys
Path(".artifacts/qualification").mkdir(parents=True, exist_ok=True)
REQUIRED = ["P1","P2","P3","P4","P5","R1","R2","R3","R4","R5","R6","R7","R8","R9","R10","M6","M7"]

def malformed(message):
    print(json.dumps({"malformed": True, "error": message}))
    sys.exit(1)

x = json.loads(Path("qualification/PRODUCTION-GATES.json").read_text())
gates = x.get("gates")
if not isinstance(gates, list) or not gates:
    malformed("missing gates")
ids = [g.get("id") for g in gates if isinstance(g, dict)]
if len(ids) != len(gates) or any(not isinstance(i, str) or not i for i in ids):
    malformed("gate id")
if len(ids) != len(set(ids)):
    malformed("duplicate gate")
if ids != REQUIRED and set(ids) != set(REQUIRED):
    malformed("gate set")
if set(ids) != set(REQUIRED):
    malformed("gate set")
allowed = set(x.get("allowedStatuses") or [])
if not allowed or any(g.get("status") not in allowed for g in gates):
    malformed("status")
if not isinstance(x.get("narrowSubchecks"), list):
    malformed("narrow subchecks")
if any(not isinstance(g, dict) or g.get("status") not in allowed for g in x["narrowSubchecks"]):
    malformed("narrow status")
if x.get("schedulerDecision") != "HELD":
    malformed("scheduler")
blocked = [g["id"] for g in gates if g["status"] != "PASS"]
blocked.append("scheduler")
r = {"productionReady": not blocked, "canary": "NO-GO" if blocked else "OWNER APPROVAL REQUIRED", "scheduler": x["schedulerDecision"], "blocked": blocked}
Path(".artifacts/qualification/GATE-STATUS.json").write_text(json.dumps(r, indent=2) + "\n")
print(json.dumps(r))
if "--enforce" in sys.argv and blocked:
    sys.exit(1)
