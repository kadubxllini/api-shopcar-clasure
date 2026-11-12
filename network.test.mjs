import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { guardPage } from './network.mjs';
import { failure, MAX_HTML } from './core.mjs';

test('native Chromium refuses redirected external/private destination and oversized transfer', { timeout: 40000 }, async () => {
  const dir = mkdtempSync('/tmp/shopcar-network-test-');
  const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [display] = await once(xvfb.stdout, 'data');
  let forbiddenHits = 0;
  const forbidden = http.createServer((_req, res) => {
    forbiddenHits++; res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' });
    res.end('globalThis.forbiddenMarker = true;');
  });
  forbidden.listen(0, '127.0.0.1'); await once(forbidden, 'listening');
  const server = http.createServer((req, res) => {
    if (req.url === '/script-page') { res.end('<html><script src="/hop-script"></script></html>'); }
    else if (req.url === '/fetch-page') { res.end('<html><script>fetch("/hop-fetch").then(r=>r.text()).catch(()=>{}).finally(()=>{globalThis.fetchDone=true})</script></html>'); }
    else if (req.url === '/frame-page') { res.end('<html><iframe src="/hop-frame"></iframe></html>'); }
    else if (req.url === '/allowed-page') { res.end('<html><script src="/allowed-hop"></script></html>'); }
    else if (req.url === '/allowed-hop') { res.writeHead(302, { Location: '/allowed-script' }); res.end(); }
    else if (req.url === '/allowed-script') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end('globalThis.allowedMarker = true;'); }
    else if (req.url.startsWith('/hop-')) { res.writeHead(302, { Location: '/redirect' }); res.end(); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: `http://localhost:${forbidden.address().port}/private` }); res.end(); }
    else if (req.url === '/oversize') { res.writeHead(200, { 'Content-Length': MAX_HTML + 100 }); res.end('large declared body'); }
    else if (req.url === '/chunked') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.write('<html><body>');
      const interval = setInterval(() => res.write('x'.repeat(65536)), 1);
      res.on('close', () => clearInterval(interval));
    } else res.end('<html><body>allowed</body></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, { headless: false, chromiumSandbox: true,
      env: { ...process.env, DISPLAY: ':' + display.toString().trim() },
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath() });
    const allowed = new WeakSet();
    await context.route('**/*', route => allowed.has(route.request().frame().page()) ? route.continue() : route.abort());
    const validate = async url => { if (!url.startsWith(base + '/')) throw failure('REJECTED_URL'); };
    for (const [path, expected] of [['/', null], ['/redirect', 'REJECTED_URL'], ['/oversize', 'PARSE_FAILED'], ['/chunked', 'PARSE_FAILED']]) {
      const page = await context.newPage(); allowed.add(page);
      let code = null;
      await guardPage(context, page, value => { code = value; }, validate);
      if (path === '/') { assert.equal((await page.goto(base + path)).status(), 200); }
      else {
        try { await page.goto(base + path, { waitUntil: 'load', timeout: 10000 }); } catch { /* aborted by guard */ }
        assert.equal(code, expected, path);
      }
      await page.close().catch(() => {});
    }
    for (const path of ['/script-page', '/fetch-page', '/frame-page', '/allowed-page']) {
      const page = await context.newPage(); allowed.add(page);
      await guardPage(context, page, () => {}, validate);
      await page.goto(base + path, { waitUntil: 'load', timeout: 10000 });
      if (path === '/fetch-page') await page.waitForFunction(() => globalThis.fetchDone === true);
      assert.equal(await page.evaluate(() => globalThis.forbiddenMarker === true), false, path);
      if (path === '/allowed-page') assert.equal(await page.evaluate(() => globalThis.allowedMarker === true), true);
      assert.equal(forbiddenHits, 0, path);
      await page.close();
    }
    assert.equal(forbiddenHits, 0);
  } finally {
    await context?.close();
    server.closeAllConnections(); forbidden.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => forbidden.close(r))]);
    xvfb.kill('SIGTERM'); await once(xvfb, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
});
