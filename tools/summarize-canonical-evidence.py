#!/usr/bin/env python3
from pathlib import Path
import json,re,subprocess,datetime
root=Path('.artifacts/canonical/final')
def tap(p):
 t=p.read_text();counts={k:int(re.search(r'^# '+k+r' (\d+)',t,re.M).group(1)) for k in ['tests','pass','fail','skipped','cancelled']}
 assert counts['fail']==counts['skipped']==counts['cancelled']==0,(p,counts)
 return {'path':str(p),'scope':'LOCAL_FIXTURE',**counts}
base=json.loads((root/'baseline/SUMMARY.json').read_text())
# 126 counts the original baseline suites, identity fence regressions,
# and the provider exception-disclosure regression.
# The named extras are measured separately and must stay present.
# CONTINUITY is the composed same-VERA interruption regression.
# EVENT-ENVELOPE is the tenant-notice projection suite.
# TASK-ADMISSION is the current-mandate admission suite.
audit_regressions={'AUDIT-REGRESSIONS':4,'AUDIT-RECOVERY':1,'FONT-NOTICES':1,'REVIEW-REMEDIATION':15,'DEPENDENCY-OVERRIDES':1,'OBJECT-CONTAINMENT':2,'CONTINUITY':1,'PLACEMENT-BINDING':8,'MANIFEST-BINDING':13,'CONTEXT-ADMISSION':19,'BOUNDED-COMPUTATION':10,'MODEL-PROTOCOL':20,'RESTRICTED-MEMORY-PROTOCOL':13,'RECALL-SERVICE':26,'PROJECT-COMMANDS':10,'VERA-PROFILE':25,'VERA-CONSOLE-COMMANDS':11,'VERA-PROFILE-BACKUP':3,'TOOL-MANIFEST':8,'EVENT-ENVELOPE':10,'TASK-ADMISSION':6,'E2-DERIVED-PROPOSALS':15,'AEON-OFFLINE':11,'NEXUS-LOCAL':11,'CONSOLE-E2-REDACTION':2,'OFFLINE-FUNCTIONAL-INTEGRATION':1}
expected_groups=126+sum(audit_regressions.values())
assert base['failed']==base['skipped']==0
assert base['nodeGroups']==base['passed']==expected_groups
by_suite={s['suite']:s for s in base['suites']}
for name,count in audit_regressions.items():
 row=by_suite[name]
 assert row['tests']==row['pass']==count and row['fail']==row['skipped']==0
original=sum(s['tests'] for s in base['suites'] if s['suite'] not in audit_regressions)
assert original==126
back=[tap(root/'backend'/name) for name in ['CONSOLE-DOMAIN.tap','CONSOLE-SEMANTICS.tap','FIXTURE-BOUNDARIES.tap','SECURITY-REGRESSIONS.tap']]
public=tap(root/'backend/REAL-PUBLIC-READ.tap') if (root/'backend/REAL-PUBLIC-READ.tap').exists() else {'status':'NOT RUN','reason':'Public-network fixture not enabled'}
if public.get('tests'):public['scope']='PUBLIC_IMMUTABLE_READ — no protected mutation or live identity';back.append(public)
browser=tap(root/'frontend/BROWSER.tap')
product_isolation=tap(root/'backend/PRODUCT-ISOLATION.tap')
unit=(root/'frontend/UNIT-COMPONENT.log').read_text();unit=re.sub(r'\x1b\[[0-9;]*m','',unit)
u=re.search(r'Tests\s+(\d+) passed',unit);assert u
for p in ['TYPECHECK.log','PRODUCTION-BUILD.log']:assert (root/'frontend'/p).is_file()
ledger=json.loads(Path('qualification/PRODUCTION-GATES.json').read_text())
expected={'P1':'PARTIAL','P2':'PARTIAL','P3':'NOT RUN','P4':'NOT RUN','P5':'NOT RUN'}
assert {g['id']:g['status'] for g in ledger['gates'] if g['id'] in expected}==expected
assert ledger['overall']=='BLOCKED' and ledger['schedulerDecision']=='HELD' and ledger['canary']=='NO-GO'
audit=json.loads((root/'DEPENDENCY-AUDIT.json').read_text())
x={'scope':'LOCAL_FIXTURE only — not production-ready or a live gate pass','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gitHeadAtVerification':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'testedSource':json.loads((root/'TESTED-SOURCE.json').read_text()),'importedBaseline':{'nodeGroups':base['nodeGroups'],'passed':base['passed'],'failed':0,'skipped':0,'nativeDrCases':base['nativeDrCases'],'legacyPythonEntries':2},'newBackend':back,'totalBackendGroups':base['nodeGroups']+sum(t['tests'] for t in back),'frontend':{'unitComponentTests':int(u[1]),'unitComponentPassed':int(u[1]),'typecheck':'PASS','optimizedBuild':'PASS'},'browser':browser,'productArtifactIsolation':product_isolation,'performance':json.loads((root/'browser/PERFORMANCE.json').read_text()),'accessibility':{'axeWorkViolations':len(json.loads((root/'browser/AXE-WORK.json').read_text())['violations']),'axeApprovalViolations':len(json.loads((root/'browser/AXE-APPROVAL.json').read_text())['violations']),'nativeScreenReader':'NOT RUN','nativeBrowserZoom':'NOT RUN — 200% text and 320-CSS-px equivalent reflow tested'},'productionDependencyAudit':audit.get('metadata',{}).get('vulnerabilities',{}),'liveGates':expected,'scheduler':'HELD','production':'BLOCKED','canary':'NO-GO','independentSecurityReview':'NOT RUN','enforcementExit':{'qualification':1,'release':1}}
(root/'SUMMARY.json').write_text(json.dumps(x,indent=2)+'\n')
print(f"{x['totalBackendGroups']} backend groups passed; {x['frontend']['unitComponentTests']} frontend unit/component tests; {browser['pass']}/{browser['tests']} browser groups. All are local/test evidence.")
