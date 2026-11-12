import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startEgressProxy } from './egress-proxy.mjs';
import { failure } from './core.mjs';

async function exchange(proxy, request) {
  const address = new URL(proxy.server);
  const socket = net.connect({ host: address.hostname, port: Number(address.port) });
  socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
  await once(socket, 'connect');
  socket.write(request);
  const [data] = await once(socket, 'data');
  socket.destroy();
  return data.toString();
}

test('egress proxy denies non-allowlisted targets and plaintext connections before dialing', async () => {
  let dialed = 0;
  const proxy = await startEgressProxy({ connect: () => { dialed++; throw new Error('must not dial'); } });
  try {
    for (const target of ['127.0.0.1:443', '169.254.169.254:443', 'evil.test:443', 'shopcar.com.br:80', 'user@shopcar.com.br:443']) {
      assert.match(await exchange(proxy, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), /403 Forbidden/);
    }
    assert.match(await exchange(proxy, 'GET http://127.0.0.1/private HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'), /403 Forbidden/);
    assert.equal(dialed, 0);
  } finally { await proxy.close(); }
});

test('egress tunnel dials the validated IP and preserves bytes in both directions', async () => {
  const echo = net.createServer(socket => socket.pipe(socket));
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  let options;
  const proxy = await startEgressProxy({
    resolve: async () => ({ addresses: [{ address: '203.0.113.25', family: 4 }] }),
    connect: value => { options = value; return net.connect({ host: '127.0.0.1', port: echo.address().port }); }
  });
  try {
    assert.match(await exchange(proxy, 'CONNECT shopcar.com.br:443 HTTP/1.1\r\nHost: shopcar.com.br:443\r\n\r\n'), /200 Connection Established/);
    assert.deepEqual(options, { host: '203.0.113.25', family: 4, port: 443 });
    const address = new URL(proxy.server);
    const socket = net.connect({ host: address.hostname, port: Number(address.port) });
    await once(socket, 'connect'); socket.write('CONNECT shopcar.com.br:443 HTTP/1.1\r\nHost: shopcar.com.br:443\r\n\r\n');
    await once(socket, 'data');
    socket.write('native TLS bytes stay unchanged');
    assert.equal((await once(socket, 'data'))[0].toString(), 'native TLS bytes stay unchanged');
    socket.destroy();
  } finally { await proxy.close(); await new Promise(resolve => echo.close(resolve)); }
});

test('egress protects isolated cross-origin frames and blob workers from redirected loopback requests', { timeout: 40000 }, async () => {
  const dir = mkdtempSync('/tmp/shopcar-egress-test-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=source.test'], { stdio: 'ignore' });
  const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [display] = await once(xvfb.stdout, 'data');
  let forbiddenHits = 0;
  const forbidden = http.createServer((_req, res) => { forbiddenHits++; res.end('must not connect'); });
  forbidden.listen(0, '127.0.0.1'); await once(forbidden, 'listening');
  let allowedHits = 0;
  const upstream = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    allowedHits++;
    if (req.url === '/bad-script' || req.url === '/bad-fetch') { res.writeHead(302, { Location: `http://127.0.0.1:${forbidden.address().port}/private` }); res.end(); }
    else if (req.url === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script src="/bad-script"></script>'); }
    else if (req.url === '/good-hop') { res.writeHead(302, { Location: '/good-script' }); res.end(); }
    else if (req.url === '/good-script') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end('globalThis.allowedMarker=true'); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<script src="/good-hop"></script><iframe src="https://child.test/frame"></iframe><script>
      const worker=new Worker(URL.createObjectURL(new Blob(['fetch("https://source.test/bad-fetch").catch(()=>{}).finally(()=>postMessage("done"))'],{type:'text/javascript'})));
      worker.onmessage=()=>{globalThis.workerDone=true;worker.terminate()};
      </script>`); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let rejected = 0;
  const proxy = await startEgressProxy({
    resolve: async url => {
      if (!['source.test', 'child.test'].includes(new URL(url).hostname)) { rejected++; throw failure('REJECTED_URL'); }
      return { addresses: [{ address: '203.0.113.25', family: 4 }] };
    },
    connect: () => net.connect({ host: '127.0.0.1', port: upstream.address().port })
  });
  let context;
  try {
    context = await chromium.launchPersistentContext(join(dir, 'profile'), {
      headless: false, chromiumSandbox: true, ignoreHTTPSErrors: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
      env: { ...process.env, DISPLAY: ':' + display.toString().trim() },
      proxy: { server: proxy.server, bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
    });
    const page = await context.newPage();
    await page.goto('https://source.test/', { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => globalThis.workerDone === true, { timeout: 10000 });
    assert.equal(await page.evaluate(() => globalThis.allowedMarker), true);
    assert(page.frames().some(frame => frame.url() === 'https://child.test/frame'));
    assert(allowedHits >= 5);
    assert.equal(forbiddenHits, 0);
    // Plain HTTP redirects are denied by the proxy's HTTP handler, not only by CORS/LNA.
    assert.match(await exchange(proxy, `CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n`), /403 Forbidden/);
    assert(rejected > 0);
  } finally {
    await context?.close(); await proxy.close();
    upstream.closeAllConnections(); forbidden.closeAllConnections();
    await Promise.all([new Promise(r => upstream.close(r)), new Promise(r => forbidden.close(r))]);
    xvfb.kill('SIGTERM'); await once(xvfb, 'exit'); rmSync(dir, { recursive: true, force: true });
  }
});
