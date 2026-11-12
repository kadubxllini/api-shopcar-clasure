import http from 'node:http';
import { guardPage } from './network.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { failure, validateUrl, validateDestination, authorized, classify, challengePage, SerialQueue, validateServiceConfig, loadPrivateConfig } from './core.mjs';

const config = loadPrivateConfig(process.env.IMPORTER_CONFIG, validateServiceConfig);
mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(`${config.stateDir}/cache.sqlite`);
db.exec('CREATE TABLE IF NOT EXISTS cache (url TEXT PRIMARY KEY, html TEXT NOT NULL, fetchedAt INTEGER NOT NULL)');
// The parser is plain JS shipped with this project; no TypeScript toolchain needed.
const parser = readFileSync(new URL('./parser.mjs', import.meta.url), 'utf8')
  .replace('export { parseShopcarHtml };', 'globalThis.shopcarParser = { parseShopcarHtml };');
let browser;
let lastCode = null;
let blockedNavigation = false;
const allowedPages = new WeakSet();
const queue = new SerialQueue();
const metrics = { success: 0, blocked: 0, timeout: 0, failed: 0, totalMs: 0 };
// Managed challenges need their own scripts; blocking them guarantees a permanent challenge page.
const CHALLENGE_TITLE = /Just a moment|Verificando|Checking your browser|Um momento/i;
const CHALLENGE_HOSTS = /(^|\.)(challenges\.cloudflare\.com|cloudflareinsights\.com)$/i;

async function settled(page, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const title = await page.title().catch(() => '');
    if (!CHALLENGE_TITLE.test(title)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(1000);
  }
}
async function context() {
  if (!browser) {
    browser = await chromium.launchPersistentContext(`${config.stateDir}/profile`, {
      headless: false, chromiumSandbox: true, timeout: 10000, executablePath: config.executablePath || undefined,
      acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 800 }
    });
    browser.on('close', () => { browser = null; });
    await browser.route('**/*', async route => {
      try {
        const request = route.request();
        if (!allowedPages.has(request.frame().page()) || request.method() !== 'GET'
          || ['image', 'media', 'font', 'stylesheet'].includes(request.resourceType())) return await route.abort();
        const host = new URL(request.url()).hostname;
        if (!['shopcar.com.br', 'www.shopcar.com.br'].includes(host)) {
          if (CHALLENGE_HOSTS.test(host)) return await route.continue();
          if (request.isNavigationRequest()) blockedNavigation = true;
          return await route.abort();
        }
        await validateDestination(request.url());
        await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
    await browser.routeWebSocket('**/*', socket => socket.close());
    // Keep the service's initial blank tab alive; close only per-job pages below.
  }
  return browser;
}
async function extract(value) {
  const url = validateUrl(value);
  const started = Date.now();
  let page;
  let deadline;
  let timedOut = false;
  let oversized = false;
  blockedNavigation = false;
  let networkCode;
  try {
    await validateDestination(url);
    db.prepare('DELETE FROM cache WHERE fetchedAt < ?').run(Date.now() - 900000);
    let html = db.prepare('SELECT html FROM cache WHERE url=?').get(url)?.html;
    const ctx = await context();
    page = await ctx.newPage();
    allowedPages.add(page);
    deadline = setTimeout(() => { timedOut = true; void page.close().catch(() => {}); }, Math.max(1, 45000 - (Date.now() - started)));
    page.setDefaultTimeout(40000);

    await guardPage(ctx, page, code => {
      networkCode = code;
      if (code === 'REJECTED_URL') blockedNavigation = true;
      if (code === 'PARSE_FAILED') oversized = true;
    });
    if (!html) {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      html = await page.content();
      const finalUrl = new URL(page.url());
      if (!['shopcar.com.br', 'www.shopcar.com.br'].includes(finalUrl.hostname)) throw failure('REJECTED_URL');
      // Removed ads redirect to the portal home instead of returning 404.
      if (finalUrl.pathname.replace(/\/+$/, '') !== new URL(url).pathname.replace(/\/+$/, '')) throw failure('NOT_FOUND');
      // A managed challenge resolves on its own in a real browser; give it that chance before failing.
      const challenged = challengePage(response?.status() || 0, html);
      if (challenged) {
        if (!(await settled(page, 12000))) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await settled(page, 8000);
        }
        html = await page.content();
      }
      await page.waitForSelector('.modelo, .marca, meta[property="og:title"]', { timeout: 8000 }).catch(() => {});
      html = await page.content();
      if (blockedNavigation) throw failure('REJECTED_URL');
      if (oversized) throw failure('PARSE_FAILED');
      // After a resolved challenge the original 403 status is stale; the HTML gate below still applies.
      classify(challenged ? 200 : (response?.status() || 503), html);
    }
    classify(200, html);
    // Parse in an isolated blank document, without running any captured scripts.
    await page.goto('about:blank');
    await page.addScriptTag({ content: parser });
    const vehicle = await page.evaluate(({ html, url }) => globalThis.shopcarParser.parseShopcarHtml(html, url), { html, url });
    if (!vehicle.brand || !vehicle.version || /^SHOPCAR\b/i.test(vehicle.version)) throw failure('PARSE_FAILED');
    vehicle.sourceUrl = url;
    vehicle.externalId = new URL(url).pathname.match(/\/(\d+)\/?$/)?.[1] || createHash('sha256').update(url).digest('hex');
    vehicle.fetchedAt = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?)').run(url, html, Date.now());
    db.exec('DELETE FROM cache WHERE url NOT IN (SELECT url FROM cache ORDER BY fetchedAt DESC LIMIT 100)');
    metrics.success++;
    lastCode = 'OK';
    return { html, vehicle, source: 'shopcar', warnings: [] };
  } catch (err) {
    const code = timedOut ? 'TIMEOUT' : blockedNavigation ? 'REJECTED_URL' : oversized ? 'PARSE_FAILED' : networkCode || err.code || (err.name === 'TimeoutError' ? 'TIMEOUT' : 'UNAVAILABLE');
    metrics[code === 'BLOCKED' ? 'blocked' : code === 'TIMEOUT' ? 'timeout' : 'failed']++;
    lastCode = code;
    throw failure(code);
  } finally {
    clearTimeout(deadline);
    await page?.close().catch(() => {});
    const ms = Date.now() - started;
    metrics.totalMs += ms;
    console.log(JSON.stringify({ code: lastCode, ms, urlHash: createHash('sha256').update(url).digest('hex') }));
  }
}
const limits = new Map();
const server = http.createServer(async (req, res) => {
  const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const client = authorized(req.headers.authorization, config.clients);
  if (!client) return reply(401, { code: 'UNAUTHORIZED' });
  if (req.method === 'GET' && req.url === '/v1/health') return reply(200, { status: 'ok', version: 1, adapters: ['shopcar'], browser_ok: !!browser });
  if (req.method === 'GET' && req.url === '/v1/metrics') return reply(200, metrics);
  if (req.method !== 'POST' || req.url !== '/v1/extract') return reply(404, { code: 'NOT_FOUND' });
  const now = Date.now();
  const recent = (limits.get(client.tokenHash) || []).filter(t => t > now - 60000);
  if (recent.length >= (client.rateLimit || 30)) return reply(429, { code: 'UNAVAILABLE' });
  recent.push(now); limits.set(client.tokenHash, recent);
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) throw failure('REJECTED_URL'); }
    const data = JSON.parse(body);
    if (!data || Array.isArray(data) || Object.keys(data).some(k => !['url', 'adapter', 'raw'].includes(k))
      || (data.adapter !== undefined && data.adapter !== 'shopcar')
      || (data.raw !== undefined && typeof data.raw !== 'boolean') || !(client.adapters || []).includes('shopcar')) throw failure('REJECTED_URL');
    validateUrl(data.url);
    const result = await queue.enqueue(() => extract(data.url));
    if (!data.raw) delete result.html;
    reply(200, result);
  } catch (err) { reply(err.code === 'REJECTED_URL' || err instanceof SyntaxError ? 400 : 502, { code: err.code || 'UNAVAILABLE' }); }
});
// Extraction is serial and can legitimately take longer than 10s; the old 10s cap cut real answers.
server.requestTimeout = 120000;
server.headersTimeout = 10000;
server.listen(config.port || 4381, '127.0.0.1');
async function shutdown() { server.close(); await browser?.close(); db.close(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
