import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkerConfig, requestJson, processNext } from './worker-client.mjs';
import { validateServiceConfig } from './core.mjs';
const config = { site: 'https://example.com', siteToken: 'a'.repeat(64), importerToken: 'b'.repeat(64) };
const job = { id: 'c'.repeat(32), lease: 'd'.repeat(64), url: 'https://www.shopcar.com.br/veiculos/123' };

test('startup rejects missing, duplicate, invalid and excessive configuration', () => {
  assert.equal(validateWorkerConfig(config).site, config.site);
  for (const patch of [{ site: 'http://example.com' }, { site: 'https://exemplo.com.br:8443/' },
    { importerToken: config.siteToken }, { siteToken: '' }, { site: config.site + '/path' }, { other: true },
    { site: 'https://localhost/' }, { site: 'https://127.0.0.1/' }, { site: 'https://user@exemplo.com.br/' },
    { importerUrl: 'https://evil.test/v1/extract' }, { importerUrl: 'http://127.0.0.1:4381/outro' }]) {
    assert.throws(() => validateWorkerConfig({ ...config, ...patch }));
  }
  // Any HTTPS site works; the project is not tied to one domain.
  assert.equal(validateWorkerConfig({ ...config, site: 'https://outra-loja.com.br' }).site, 'https://outra-loja.com.br');
  assert.equal(validateWorkerConfig(config).importerUrl, 'http://127.0.0.1:4381/v1/extract');
  assert.equal(validateWorkerConfig({ ...config, importerUrl: 'http://127.0.0.1:4400/v1/extract' }).importerUrl,
    'http://127.0.0.1:4400/v1/extract');
  const service = { stateDir: '/tmp/isolated', clients: [{ tokenHash: 'a'.repeat(64), adapters: ['shopcar'] }] };
  assert.equal(validateServiceConfig(service), service);
  for (const patch of [{ stateDir: 'relative' }, { clients: [] }, { port: 0 }, { other: true },
    { clients: [{ ...service.clients[0], rateLimit: 0 }] }, { clients: [service.clients[0], service.clients[0]] }]) {
    assert.throws(() => validateServiceConfig({ ...service, ...patch }));
  }
});

test('worker uses distinct credentials, no redirects, bounded fetch and never writes stock', async () => {
  const calls = [];
  const replies = [{ job }, { html: 'x'.repeat(350), vehicle: { brand: 'Jeep', version: 'Compass' } }, { success: true }];
  const fetcher = async (url, options) => { calls.push({ url, options }); return Response.json(replies.shift()); };
  assert.equal(await processNext(config, fetcher), 'OK');
  assert.deepEqual(calls.map(c => new URL(c.url).search || new URL(c.url).pathname), ['?action=import_claim', '/v1/extract', '?action=import_result']);
  assert.deepEqual(calls.map(c => c.options.headers.Authorization), [`Bearer ${config.siteToken}`, `Bearer ${config.importerToken}`, `Bearer ${config.siteToken}`]);
  assert(calls.every(c => c.options.redirect === 'error' && c.options.signal instanceof AbortSignal));
});

for (const [status, expected] of [[401, 'UNAVAILABLE'], [429, 'UNAVAILABLE'], [500, 'UNAVAILABLE'], [502, 'BLOCKED']]) {
  test(`worker reports ${status} without restarting capture`, async () => {
    let calls = 0;
    let payload;
    const fetcher = async (_url, options) => {
      calls++;
      if (calls === 1) return Response.json({ job });
      if (calls === 2) return Response.json({ code: status === 502 ? 'BLOCKED' : 'UNAUTHORIZED' }, { status });
      payload = JSON.parse(options.body);
      return Response.json({ success: true });
    };
    assert.equal(await processNext(config, fetcher), expected);
    assert.equal(payload.code, expected);
    assert.equal(calls, 3);
  });
}
test('worker timeout and malicious queued URL fail safely; idle has no side effect', async () => {
  for (const [queued, expected] of [[job, 'TIMEOUT'], [{ ...job, url: 'https://127.0.0.1/' }, 'REJECTED_URL']]) {
    let calls = 0;
    const fetcher = async (url, options) => {
      calls++;
      if (url.includes('import_claim')) return Response.json({ job: queued });
      if (url.includes('/v1/extract')) throw new DOMException('timeout', 'TimeoutError');
      assert.equal(JSON.parse(options.body).code, expected);
      return Response.json({ success: true });
    };
    assert.equal(await processNext(config, fetcher), expected);
    assert.equal(calls, expected === 'TIMEOUT' ? 3 : 2);
  }
  let calls = 0;
  assert.equal(await processNext(config, async () => { calls++; return Response.json({ job: null }); }), null);
  assert.equal(calls, 1);
});
test('UTF-8 split across chunks is preserved and oversized responses rejected', async () => {
  const bytes = Buffer.from('{"text":"à"}');
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 10)); c.enqueue(bytes.subarray(10)); c.close(); } });
  assert.deepEqual(await requestJson('https://unused.test', {}, '', 1000, async () => new Response(stream)), { text: 'à' });
  await assert.rejects(requestJson('https://unused.test', {}, '', 1000, async () => new Response('x'.repeat(5242881))), { code: 'PARSE_FAILED' });
});
