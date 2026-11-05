"""Disposable, network-none PostgreSQL qualification. Never selects production.

Uses the already-present image; no pulls, production mounts, passwords or ports.
Only the disposable container created here is removed in the finally block.
"""
import json, os, pathlib, subprocess, time, uuid

APP = pathlib.Path(__file__).resolve().parents[2]
ROOT = pathlib.Path('/tmp/alrifai-identity-review-20261012')
IMAGE = 'sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
NAME = 'alrifai-identity-qualification-' + uuid.uuid4().hex[:12]
DATABASE = 'alrifai_identity_qualification_20261012'
NODE = '/tmp/alrifai-preparation-node'

def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)

os.umask(0o077)
ROOT.mkdir(mode=0o700, exist_ok=True)
socket = ROOT / ('socket-' + NAME)
socket.mkdir(mode=0o700)
created = False
try:
    run(['docker', 'image', 'inspect', IMAGE])
    run(['docker', 'run', '-d', '--name', NAME, '--network', 'none', '--read-only',
         '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '128',
         '--security-opt', 'no-new-privileges', '--restart', 'no',
         '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=128m',
         '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
         '--mount', 'type=bind,src=' + str(socket) + ',dst=/var/run/postgresql',
         '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=' + DATABASE,
         IMAGE, 'postgres', '-c', 'listen_addresses='])
    created = True
    for _ in range(40):
        ready = subprocess.run(['docker', 'exec', NAME, 'pg_isready', '-U', 'postgres', '-d', DATABASE], capture_output=True)
        if ready.returncode == 0:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Disposable PostgreSQL readiness failed')
    env = dict(os.environ, ALRIFAI_QUALIFICATION_SOCKET=str(socket), ALRIFAI_QUALIFICATION_DATABASE=DATABASE)
    result = subprocess.run([NODE, '--experimental-strip-types', '--test', 'tests/identity-review-postgres.mjs'],
                            cwd=APP, env=env, text=True, capture_output=True, timeout=90)
    (ROOT / 'postgres.tap').write_text(result.stdout + result.stderr)
    print(json.dumps({'exitCode': result.returncode, 'network': 'none', 'productionConnections': 0,
                      'report': str(ROOT / 'postgres.tap')}))
    if result.returncode:
        raise RuntimeError('Disposable PostgreSQL tests failed; inspect private report')
finally:
    if created:
        run(['docker', 'rm', '-f', NAME])
    # Socket files are owned by the container's postgres UID; no real data volume exists.
    for path in socket.iterdir():
        if path.is_file() or path.is_socket():
            path.unlink()
    socket.rmdir()
