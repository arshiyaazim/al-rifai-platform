#!/usr/bin/env python3
"""Content-free local readiness; never emit credentials or source message text."""
import json,pathlib,datetime,subprocess
now=datetime.datetime.now(datetime.timezone.utc);items={}
for key,path,hours in [('backup','/var/backups/vps/al-rifai/last-success.json',27),('reconciliation','/var/lib/vps/al-rifai/reconciliation/last-success.json',1)]:
 try:
  p=pathlib.Path(path);v=json.loads(p.read_text());age=(now-datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc)).total_seconds();failure=p.with_name('last-failure.json');items[key]={'ready':age<hours*3600 and (not failure.exists() or failure.stat().st_mtime<p.stat().st_mtime),'ageSeconds':int(age),'status':v.get('status', 'PASS'),'processingErrors':len(v.get('processingErrors',[]))}
  if items[key]['processingErrors']:items[key]['ready']=False
 except Exception:items[key]={'ready':False,'status':'UNAVAILABLE'}
for n in ['al-rifai-app-1','vps-infra-postgres-1','vps-whatsapp-wa-01-cap4-20261011','vps-whatsapp-wa-02-cap4-20261011']:
 r=subprocess.run(['docker','inspect','--format','{{.State.Status}}',n],capture_output=True,text=True);items[n]={'ready':r.returncode==0 and r.stdout.strip()=='running'}
print(json.dumps({'at':now.isoformat(),'ready':all(v['ready'] for v in items.values()),'checks':items},indent=2));raise SystemExit(0 if all(v['ready'] for v in items.values()) else 1)
