import ast,asyncio,json
from pathlib import Path
class HTTPException(Exception):
 def __init__(self,status,detail):self.status_code=status
async def main():
 results={}
 for file,name in [('tests/fixtures/legacy-fail-closed/dispatch.py','dispatch_effect'),('tests/fixtures/legacy-fail-closed/nexus.py','_live_dispatch')]:
  source=ast.parse(Path(file).read_text());fn=next(n for n in source.body if isinstance(n,(ast.AsyncFunctionDef,ast.FunctionDef)) and n.name==name);fn.decorator_list=[]
  namespace={'HTTPException':HTTPException};exec(compile(ast.Module(body=[fn],type_ignores=[]),file,'exec'),namespace)
  try:
   if name=='dispatch_effect':await namespace[name]('any-effect')
   else:namespace[name](lambda *a:(_ for _ in ()).throw(AssertionError('transport reached')),{},'action',{},[], '_start', {})
   raise AssertionError('legacy path did not fail closed')
  except HTTPException as e:assert e.status_code==503;results[name]='503 before DB/adapter access'
  except RuntimeError:results[name]='disabled before wire/fallback access'
 print(json.dumps(results))
asyncio.run(main())
