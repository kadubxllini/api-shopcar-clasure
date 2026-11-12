import { chromium } from 'playwright';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';

test('HTTP auth, URL/schema, rate limit and offline cached parsing in real headed Chromium', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shopcar-import-http-'));
  const first = randomBytes(32).toString('hex');
  const second = randomBytes(32).toString('hex');
  const html = `<html><title>Shopcar Toyota</title><body><span class="marca">Toyota</span><span class="modelo">Corolla Altis Teste</span>
    <div class="barra-preco">R$ 125.000,00</div><div class="caract-anomodelo">2023/2024</div><div class="caract-km">45.000 Km</div>
    <div class="caract-cambio">Automático</div><div class="dv-imagens"><a class="fotogroup" href="https://cdn.shopcar.com.br/stored/veiculos/fixture.jpg">Foto</a></div></body></html>`;
  const url = 'https://www.shopcar.com.br/veiculos/toyota/corolla/123';
  mkdirSync(join(dir, 'state'));
  const db = new DatabaseSync(join(dir, 'state/cache.sqlite'));
  db.exec('CREATE TABLE cache (url TEXT PRIMARY KEY, html TEXT NOT NULL, fetchedAt INTEGER NOT NULL)');
  db.prepare('INSERT INTO cache VALUES (?,?,?)').run(url, html, Date.now()); db.close();
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ stateDir: join(dir, 'state'), port,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
    clients: [first, second].map((token, i) => ({ tokenHash: createHash('sha256').update(token).digest('hex'), adapters: ['shopcar'], rateLimit: i ? 30 : 2 })) }), { mode: 0o600 });
  const child = spawn('xvfb-run', ['-a', process.execPath, 'server.mjs'], {
    cwd: new URL('.', import.meta.url), env: { ...process.env, IMPORTER_CONFIG: join(dir, 'config.json') }, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  const endpoint = `http://127.0.0.1:${port}`;
  const call = (path, body, token = second) => fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Service exited: ' + stderr);
      try { await call('/v1/health'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert(ready, 'Service failed to listen');
    assert.equal((await call('/v1/health', undefined, 'wrong')).status, 401);
    assert.equal((await call('/v1/health')).status, 200);
    for (const body of [{ url: 'https://127.0.0.1/' }, { url, raw: 'true' }]) assert.equal((await call('/v1/extract', body, first)).status, 400);
    assert.equal((await call('/v1/extract', { url }, first)).status, 429);
    const response = await call('/v1/extract', { url, raw: true });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result) + stderr);
    assert.equal(result.html, html);
    assert.equal(result.vehicle.brand, 'Toyota');
    assert.equal(result.vehicle.version, 'Corolla Altis Teste');
    assert.equal(result.vehicle.price, 125000);
    assert.equal(result.vehicle.photos.length, 1);
    assert.equal(result.vehicle.externalId, '123');
    assert.equal((await (await call('/v1/health')).json()).browser_ok, true);
    assert.equal((await (await call('/v1/metrics')).json()).success, 1);
  } finally {
    // Own isolated process group/profile only; no shared browser is touched.
    process.kill(-child.pid, 'SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
});
