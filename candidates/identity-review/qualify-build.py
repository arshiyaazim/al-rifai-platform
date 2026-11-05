"""Compile an offline Next.js preview in a disposable network-none container.

No source mount in a live container, secret mounts, published ports, or services.
"""
import json, os, pathlib, shutil, subprocess, uuid

APP = pathlib.Path(__file__).resolve().parents[2]
ROOT = pathlib.Path('/tmp/alrifai-identity-review-20261012')
IMAGE = 'sha256:948e9f44bfc143cfd848cb9e68c1503b08ac35f60c70b5e41ecf13c06a73bc98'
name = 'alrifai-identity-build-' + uuid.uuid4().hex[:12]
os.umask(0o077)
ROOT.mkdir(mode=0o700, exist_ok=True)
copy = ROOT / ('build-' + name)
shutil.copytree(APP, copy, ignore=shutil.ignore_patterns('node_modules', '.next', '.git', '__pycache__', 'tsconfig.tsbuildinfo'))
preview = copy / 'app' / 'offline-identity-review'
preview.mkdir()
(preview / 'page.tsx').write_text("import Panel from '../../candidates/identity-review/ui/IdentityReviewPanel';\nexport const dynamic='force-dynamic';\nexport default function Preview(){return <Panel/>;}\n")
for directory, dirs, files in os.walk(copy):
    os.chown(directory, 10001, 10001)
    for file in files:
        os.chown(pathlib.Path(directory) / file, 10001, 10001)
try:
    result = subprocess.run(['docker', 'run', '--rm', '--name', name, '--network', 'none',
        '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '2g', '--memory-swap', '2g', '--cpus', '1', '--pids-limit', '128',
        '--no-healthcheck', '--tmpfs', '/tmp:rw,nosuid,size=64m',
        '--mount', 'type=bind,src=' + str(copy) + ',dst=/offline',
        '--mount', 'type=bind,src=' + str(APP / 'node_modules') + ',dst=/offline/node_modules,readonly',
        '-w', '/offline', '-e', 'NEXT_TELEMETRY_DISABLED=1', '-e', 'NODE_OPTIONS=--max-old-space-size=1024', '--entrypoint', 'node', IMAGE,
        '/offline/node_modules/next/dist/bin/next', 'build', '--webpack'], text=True, capture_output=True, timeout=300)
    (ROOT / 'build.log').write_text(result.stdout + result.stderr)
    print(json.dumps({'exitCode': result.returncode, 'network': 'none', 'previewOnly': True,
                      'report': str(ROOT / 'build.log')}))
    if result.returncode:
        raise RuntimeError('Offline preview build failed; inspect private report')
finally:
    # Remove only this compiler container if a timeout prevented --rm cleanup.
    subprocess.run(['docker', 'rm', '-f', name], text=True, capture_output=True)
