#!/usr/bin/env python3
"""Root-only local encrypted recovery. Never restore production/nonempty targets."""
import argparse, datetime as dt, hashlib, json, os, pathlib, re, shutil, sqlite3, subprocess, tarfile, tempfile, fcntl
ROOT=pathlib.Path('/var/backups/vps/al-rifai');KEY=pathlib.Path('/etc/vps/recovery/al-rifai-gnupg');PG='vps-infra-postgres-1'
# Live database is alrifai_v2_phase3. The legacy 'alrifai' database predates the
# Phase 3 cutover and must never be the backup target.
DB=os.environ.get('ALRIFAI_BACKUP_DB','alrifai_v2_phase3')
def run(args,**kw):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kw)
 if r.returncode:raise RuntimeError('COMMAND_FAILED: '+args[0]+' exit='+str(r.returncode))
 return r.stdout
def pg(sql,db=DB):
 return run(['docker','exec','-i',PG,'psql','-XqAt','-U','vps_pg_admin','-d',db,'-v','ON_ERROR_STOP=1'],input=sql.encode()).decode().strip()
def fingerprint_sql():
 return """SELECT format('SELECT jsonb_build_object(''table'',%L,''count'',count(*),''digest'',md5(coalesce(string_agg(h,'''' ORDER BY h),''''))) FROM (SELECT md5(to_jsonb(t)::text) h FROM %I.%I t) q;',schemaname||'.'||tablename,schemaname,tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename;
\\gexec
SELECT jsonb_build_object('ledger',(SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version) FROM public.schema_migrations),'cash',(SELECT jsonb_build_object('count',count(*),'minor',coalesce(sum(amount_minor),0),'review',count(*) FILTER(WHERE state='REVIEW')) FROM public.cash_instructions),'postings',(SELECT count(*) FROM public.cash_postings),'links',(SELECT count(*) FROM public.identity_aliases));
"""
def frames(text):return [json.loads(l) for l in text.splitlines() if l.startswith('{')]
def fingerprint(db=DB):return frames(pg('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+fingerprint_sql()+'ROLLBACK;',db))
def guard_target(name):
 if not re.fullmatch(r'alrifai_restore_validation_[0-9]{8}_[0-9]{6}',name):raise ValueError('RESTORE_TARGET_DENIED')
 if name in ['alrifai','postgres','template0','template1']:raise ValueError('PRODUCTION_TARGET_DENIED')
 return name
def recipient():
 data=run(['gpg','--homedir',str(KEY),'--batch','--with-colons','--list-keys']).decode()
 return next(l.split(':')[9] for l in data.splitlines() if l.startswith('fpr:'))
def encrypt(src,dst):
 run(['gpg','--homedir',str(KEY),'--batch','--yes','--trust-model','always','--recipient',recipient(),'--output',str(dst),'--encrypt',str(src)]);dst.chmod(0o600)
def decrypt(src,dst):
 run(['gpg','--homedir',str(KEY),'--batch','--yes','--output',str(dst),'--decrypt',str(src)]);dst.chmod(0o600)
def backup(rehearse=False,include_image=False):
 os.umask(0o077);ROOT.mkdir(parents=True,exist_ok=True);stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d_%H%M%S');stage=pathlib.Path(tempfile.mkdtemp(prefix='.stage-',dir=ROOT));status={'startedUTC':dt.datetime.now(dt.timezone.utc).isoformat(),'id':stamp,'restore':'Not tested'}
 try:
  # Keep the exported snapshot alive while both dump and attestation read it.
  holder=subprocess.Popen(['docker','exec','-i',PG,'psql','-XqAt','-U','vps_pg_admin','-d',DB,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  holder.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n');holder.stdin.flush();snapshot=holder.stdout.readline().strip()
  if not re.fullmatch(r'[0-9A-F-]+',snapshot):raise RuntimeError('SNAPSHOT_FAILED')
  try:
   with (stage/'alrifai.dump').open('wb') as out:
    r=subprocess.run(['docker','exec',PG,'pg_dump','-U','vps_pg_admin','-d',DB,'-Fc','--snapshot='+snapshot],stdout=out,stderr=subprocess.PIPE)
    if r.returncode:raise RuntimeError('PG_DUMP_FAILED')
   holder.stdin.write(fingerprint_sql()+"\\echo SNAPSHOT_ATTESTATION_DONE\n");holder.stdin.flush();lines=[]
   while True:
    line=holder.stdout.readline()
    if not line:raise RuntimeError('SNAPSHOT_ATTESTATION_FAILED')
    if line.strip()=='SNAPSHOT_ATTESTATION_DONE':break
    lines.append(line)
   expected=frames(''.join(lines));(stage/'database-baseline.json').write_text(json.dumps(expected,indent=2))
   holder.stdin.write('ROLLBACK;\n\\q\n');holder.stdin.flush();holder.wait(timeout=20)
  finally:
   if holder.poll() is None:holder.terminate();holder.wait(timeout=20)
  for repo,bundle in [('/opt/al-rifai-platform','platform-source-history.bundle'),('/opt/vps','vps-foundation-history.bundle')]:
   if pathlib.Path(repo,'.git').is_dir():
    run(['git','-C',repo,'bundle','create',str(stage/bundle),'--all'])
  (stage/'globals.sql').write_bytes(run(['docker','exec',PG,'pg_dumpall','-U','vps_pg_admin','--globals-only']))
  states={}
  for account in ['wa-01','wa-02']:
   dest=stage/'whatsapp'/account;dest.mkdir(parents=True)
   states[account]={}
   for name in ['messages.db','whatsapp.db']:
    src=pathlib.Path('/var/lib/vps/whatsapp')/account/'store'/name
    with sqlite3.connect(src.as_uri()+'?mode=ro',uri=True,timeout=15) as live,sqlite3.connect(dest/name) as saved:
     live.execute('PRAGMA query_only=ON');live.backup(saved,pages=1024,sleep=.05)
     if saved.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('SQLITE_BACKUP_INTEGRITY_FAILED')
     states[account][name]={'quick_check':'ok','sha256':hashlib.sha256((dest/name).read_bytes()).hexdigest()}
   shutil.copytree(pathlib.Path('/var/lib/vps/whatsapp')/account/'outbox',dest/'outbox',dirs_exist_ok=True)
  (stage/'sqlite-verification.json').write_text(json.dumps(states,indent=2))
  # Discover live containers by name so a redeploy that renames a service cannot
  # break the nightly backup.
  running=run(['docker','ps','-a','--format','{{.Names}}']).decode().split()
  names=sorted(c for c in running if c in ('al-rifai-phase3-app-1','al-rifai-phase3-sync-1','al-rifai-recruitment-ai') or c.startswith('vps-whatsapp-wa-') or c==PG)
  if not names:raise RuntimeError('NO_CONTAINERS_DISCOVERED')
  runtime=run(['docker','inspect',*names]);(stage/'runtime-private.json').write_bytes(runtime)
  with tarfile.open(stage/'config-source.tar.gz','w:gz') as tar:
   for name in ['/etc/vps/apps','/etc/vps/infra','/etc/vps/services','/etc/systemd/system/alrifai-recovery.service','/etc/systemd/system/alrifai-recovery.timer','/etc/systemd/system/alrifai-reconciliation.service','/etc/systemd/system/alrifai-reconciliation.timer','/opt/vps/infra/compose.yaml','/opt/vps/services/whatsapp/compose.yaml','/opt/vps/apps/al-rifai','/opt/al-rifai-platform/compose.yaml','/opt/al-rifai-platform/compose.phase3.yaml','/opt/al-rifai-platform/scripts/operations']:
    def filt(info):
     if any(part in ['node_modules','.next','.pnpm-store','qualification','data','.git','__pycache__'] for part in pathlib.PurePosixPath(info.name).parts):return None
     return info
    if pathlib.Path(name).exists():tar.add(name,arcname=name.lstrip('/'),filter=filt)
   if pathlib.Path('/var/lib/vps/al-rifai/evidence').is_dir():tar.add('/var/lib/vps/al-rifai/evidence',arcname='evidence')
   for name in ['NEXT-SESSION-HANDOFF.md','docs/VPS_MAP.md','AGENTS.md']:
    if pathlib.Path('/opt/vps',name).exists():tar.add('/opt/vps/'+name,arcname='foundation/'+name)
   for data_dir in ['/opt/vps/apps/al-rifai/data','/opt/al-rifai-platform/data']:
    if pathlib.Path(data_dir).is_dir():
     for p in pathlib.Path(data_dir).iterdir():
      if p.is_file() and p.suffix in ['.json','.patch','.sql']:
       tar.add(p,arcname='release-evidence/'+p.name)
  if include_image:
   image=json.loads(runtime)[0]['Image']
   with (stage/'app-image.tar').open('wb') as out:
    r=subprocess.run(['docker','image','save',image],stdout=out,stderr=subprocess.PIPE)
    if r.returncode:raise RuntimeError('IMAGE_PRESERVATION_FAILED')
  if rehearse:
   target=guard_target('alrifai_restore_validation_'+stamp)
   pg('CREATE DATABASE '+target+' OWNER alrifai_app;',db='postgres')
   objects=pg("SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');",target)
   if objects!='0':raise RuntimeError('NONEMPTY_RESTORE_TARGET_DENIED')
   with (stage/'alrifai.dump').open('rb') as inp:
    r=subprocess.run(['docker','exec','-i',PG,'pg_restore','-U','vps_pg_admin','--exit-on-error','--single-transaction','--dbname='+target],stdin=inp,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   if r.returncode:raise RuntimeError('ISOLATED_RESTORE_FAILED_TARGET_RETAINED')
   actual=fingerprint(target);ok=actual==expected
   (stage/'restore-verification.json').write_text(json.dumps({'target':target,'atUTC':dt.datetime.now(dt.timezone.utc).isoformat(),'expected':expected,'actual':actual,'equal':ok},indent=2))
   if not ok:raise RuntimeError('RESTORE_FINGERPRINT_MISMATCH_TARGET_RETAINED')
   status.update(restore='PASS',restoreTarget=target,verifiedTables=len([f for f in expected if 'table' in f]))
   # Only the exact just-created, empty-guarded, verified disposable target.
   pg('DROP DATABASE '+guard_target(target)+';',db='postgres')
  manifest={p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in stage.iterdir() if p.is_file()};(stage/'manifest.json').write_text(json.dumps(manifest,indent=2))
  plain=ROOT/('.bundle-'+stamp+'.tar');encrypted=ROOT/('recovery-'+stamp+'.tar.gpg')
  with tarfile.open(plain,'w') as tar:tar.add(stage,arcname=stamp)
  encrypt(plain,encrypted)
  check=ROOT/('.decrypt-'+stamp+'.tar');decrypt(encrypted,check)
  if hashlib.sha256(plain.read_bytes()).digest()!=hashlib.sha256(check.read_bytes()).digest():raise RuntimeError('ENCRYPTION_ROUNDTRIP_FAILED')
  plain.unlink();check.unlink();shutil.rmtree(stage)
  status.update(completedUTC=dt.datetime.now(dt.timezone.utc).isoformat(),status='PASS',archive=str(encrypted),sha256=hashlib.sha256(encrypted.read_bytes()).hexdigest(),encryptionRoundtrip=True,sqliteAccounts=2,offHost='NOT_CONFIGURED')
  (ROOT/'last-success.json').write_text(json.dumps(status,indent=2))
  # Retain seven daily bundles. Never delete unrelated/legacy backups.
  old=sorted(ROOT.glob('recovery-????????_??????.tar.gpg'))[:-7]
  for f in old:f.unlink()
  print(json.dumps(status));return status
 except Exception as e:
  (ROOT/'last-failure.json').write_text(json.dumps({'atUTC':dt.datetime.now(dt.timezone.utc).isoformat(),'status':'FAILED','code':str(e),'privateStage':str(stage)}));raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--rehearse',action='store_true');p.add_argument('--include-image',action='store_true');a=p.parse_args()
 ROOT.mkdir(parents=True,exist_ok=True)
 with (ROOT/'.backup.lock').open('w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);backup(a.rehearse,a.include_image)
