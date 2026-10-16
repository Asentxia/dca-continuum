#!/usr/bin/env python3
"""Limited local export hygiene scan; not a credential validity check or independent audit."""
from pathlib import Path
import subprocess,re,json,datetime
names=sorted(set(subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],text=True).splitlines()))
patterns={
 'private_key_material':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{100,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'unredacted_jwt_shape':re.compile(rb'(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{24,}'),
 'github_credential_shape':re.compile(rb'(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})'),
 'aws_access_key_shape':re.compile(rb'(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])'),
 'embedded_database_credential':re.compile(rb'(?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s\/:@]+:[^\s\/@]{8,}@')
}
findings=[];badpaths=[];symlinks=[];checked=0
for name in names:
 p=Path(name)
 if p.is_symlink():symlinks.append(name);continue
 if not p.is_file():continue
 if any(x in p.parts for x in ['node_modules','.local','.next','__pycache__']) or p.name=='.env' or p.name.endswith(('.pem','.key','.dump','.sqlite')):badpaths.append(name)
 data=p.read_bytes();checked+=1
 for label,pattern in patterns.items():
  for m in pattern.finditer(data):findings.append({'path':name,'line':data[:m.start()].count(b'\n')+1,'finding':label,'value':'OMITTED'})
result={'status':'PASS' if not findings and not badpaths and not symlinks else 'REVIEW REQUIRED','scope':'Local source/export hygiene only — not independent security review','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'filesScanned':checked,'findings':findings,'forbiddenExportPaths':badpaths,'symlinks':symlinks,'limits':['Heuristic patterns can miss secrets; no secret validity or account access attempted.','Generated fixture/test constants and public JWKS are not production credentials.','Binary screenshot inspection was agent review of fixture-only rendered data, not OCR/secret-detection certification.'],'independentReview':'NOT RUN'}
Path('.artifacts/canonical/final/LOCAL-EXPORT-SCAN.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:result[k] for k in ['status','filesScanned','findings','forbiddenExportPaths','symlinks']},indent=2))
