#!/usr/bin/env node
// AL-RIFA'I — write a password to a root-only secret file without echo.
//
// The Owner runs this interactively over SSH. The password is not accepted as
// an argument, is not echoed, and is not written to shell history.
//
//   node --experimental-strip-types scripts/standalone/set-secret-password.mjs \
//     --file=/etc/vps/apps/al-rifai/admin-bootstrap-password
import {chmodSync, chownSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {isAcceptablePassword} from '../../lib/password-policy.ts';

const arg = (name) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const file = arg('file');
if (!file) {
  console.error(JSON.stringify({status: 'FAILED', code: 'FILE_REQUIRED'}));
  process.exit(1);
}

let stdinLines = null;
async function nextStdinLine() {
  if (!stdinLines) {
    stdinLines = (async () => {
      const rl = createInterface({input: process.stdin});
      const lines = [];
      for await (const line of rl) lines.push(line);
      return lines;
    })();
  }
  const lines = await stdinLines;
  return lines.length ? lines.shift() : '';
}

function askHidden(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      process.stdout.write(label);
      nextStdinLine().then((line) => resolve(line)).catch(reject);
      return;
    }
    process.stdout.write(label);
    stdin.resume();
    stdin.setRawMode(true);
    let value = '';
    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const first = await askHidden('New password: ');
  if (!isAcceptablePassword(first)) {
    console.error(JSON.stringify({status: 'FAILED', code: 'PASSWORD_POLICY'}));
    process.exit(1);
  }
  const second = await askHidden('Confirm password: ');
  if (first !== second) {
    console.error(JSON.stringify({status: 'FAILED', code: 'PASSWORD_MISMATCH'}));
    process.exit(1);
  }
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, first, {mode: 0o400});
  chmodSync(file, 0o400);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    chownSync(file, 0, 0);
  }
  console.log(JSON.stringify({status: 'PASSWORD_FILE_WRITTEN', file, bytes: Buffer.byteLength(first)}, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'PASSWORD_FILE_FAILED'}));
  process.exitCode = 1;
});
