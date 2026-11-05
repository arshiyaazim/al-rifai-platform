#!/usr/bin/env node
// AL-RIFA'I — HTTPS entry point.
//
// Runs the Next.js standalone server on a private loopback port and terminates
// TLS in front of it on 3443. This mirrors the existing infrastructure: the
// certificate and key are mounted from the host, nothing is generated here,
// and the public hostname is whatever the certificate was issued for.
//
// Environment:
//   TLS_KEY_FILE   default /etc/alrifai/tls/private-entry.key
//   TLS_CERT_FILE  default /etc/alrifai/tls/private-entry.crt
//   TLS_PORT       default 3443
//   PORT           internal Next.js port, default 3000
import https from 'node:https';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {loadEnv} from '../lib/env.mjs';

// The single configuration source. Inside a container the same keys also arrive
// as environment variables; those always win, so loading is idempotent.
loadEnv();

const INTERNAL_PORT = Number(process.env.PORT ?? 3000);
const TLS_PORT = Number(process.env.TLS_PORT ?? 3443);
const KEY_FILE = process.env.TLS_KEY_FILE ?? '/etc/alrifai/tls/private-entry.key';
const CERT_FILE = process.env.TLS_CERT_FILE ?? '/etc/alrifai/tls/private-entry.crt';

let stopping = false;

const child = spawn(process.execPath, ['server.js'], {
  stdio: 'inherit',
  env: {...process.env, PORT: String(INTERNAL_PORT), HOSTNAME: '127.0.0.1'},
});
child.on('exit', (code, signal) => {
  if (stopping) return;
  console.error(`[entry] application exited code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

let active = 0;

const server = https.createServer(
  {
    key: readFileSync(KEY_FILE),
    cert: readFileSync(CERT_FILE),
    maxHeaderSize: 16_384,
  },
  (request, response) => {
    if (active >= 64) {
      response.writeHead(503, {connection: 'close'});
      response.end();
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };

    const headers = {...request.headers};
    headers['x-forwarded-proto'] = 'https';
    if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = request.socket.remoteAddress ?? '';

    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: INTERNAL_PORT,
        path: request.url,
        method: request.method,
        headers,
        timeout: 190_000,
      },
      (reply) => {
        if (response.destroyed) {
          reply.destroy();
          return;
        }
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );

    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(503, {connection: 'close'});
      response.end();
    });
    upstream.on('timeout', () => upstream.destroy());
    response.on('close', () => {
      release();
      if (!response.writableFinished) upstream.destroy();
    });
    request.on('error', () => upstream.destroy());
    response.on('error', () => upstream.destroy());
    request.pipe(upstream);
  },
);

server.requestTimeout = 180_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(TLS_PORT, '0.0.0.0', () => {
  console.log(`[entry] https on ${TLS_PORT} -> 127.0.0.1:${INTERNAL_PORT}`);
});

const shutdown = (signal) => {
  stopping = true;
  console.log(`[entry] ${signal}; shutting down`);
  server.close();
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
