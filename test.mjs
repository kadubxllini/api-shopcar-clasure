import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateUrl, authorized, classify, challengePage, SerialQueue, validateResourceDestination } from './core.mjs';

test('URL boundary rejects SSRF, credentials, protocol, port and deceptive hosts', () => {
  for (const url of ['http://shopcar.com.br/', 'https://shopcar.com.br:81/', 'https://a@shopcar.com.br/',
    'https://shopcar.com.br.evil.test/', 'https://127.0.0.1/', 'file:///etc/passwd',
    'https://shopcar.com.br\\@evil.test/', 'https://shopcar.com.br/\n']) {
    assert.throws(() => validateUrl(url), { code: 'REJECTED_URL' });
  }
  assert.equal(validateUrl('https://www.shopcar.com.br/veiculos/123#x'), 'https://www.shopcar.com.br/veiculos/123');
});
test('revocation and per-client bearer authentication', () => {
  const token = 'a'.repeat(64);
  const client = { tokenHash: createHash('sha256').update(token).digest('hex') };
  assert.equal(authorized(`Bearer ${token}`, [client]), client);
  assert.equal(authorized(`Bearer ${token}`, []), null);
  assert.equal(authorized(`Bearer ${'b'.repeat(64)}`, [client]), null);
  assert.equal(authorized('', [client]), null);
});
test('blocks and removed ads have distinct errors; challenge is never parsed', () => {
  assert.throws(() => classify(403, ''), { code: 'BLOCKED' });
  assert.throws(() => classify(200, '<title>Just a moment...</title>'), { code: 'BLOCKED' });
  assert.throws(() => classify(404, ''), { code: 'NOT_FOUND' });
  assert.throws(() => classify(200, 'x'), { code: 'PARSE_FAILED' });
  assert.throws(() => classify(200, 'x'.repeat(5242881)), { code: 'PARSE_FAILED' });
});
test('a legitimate page carrying Cloudflare jsd is not a challenge', () => {
  const html = '<title>JEEP Compass 2025</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
  assert.equal(challengePage(200, html), false);
  assert.doesNotThrow(() => classify(200, html.padEnd(400, ' ')));
  assert.equal(challengePage(403, html), true);
  assert.equal(challengePage(200, '<title>Just a moment...</title>'), true);
  assert.equal(challengePage(200, '<div class="cf-chl-widget"></div>'), true);
});
test('one job at a time, bounded queue, failure does not poison subsequent jobs', async () => {
  const queue = new SerialQueue();
  let active = 0;
  const run = async () => { assert.equal(++active, 1); await new Promise(r => setTimeout(r, 5)); --active; return 42; };
  const first = queue.enqueue(async () => { throw new Error('test'); });
  const second = queue.enqueue(run);
  await assert.rejects(first, /test/);
  assert.equal(await second, 42);
  queue.pending = 10;
  await assert.rejects(queue.enqueue(run), { code: 'UNAVAILABLE' });
});


test('resource destinations reject unsafe protocols, private IPs, credentials and wildcard subdomains', async () => {
  for (const url of ['http://challenges.cloudflare.com/script.js', 'https://user@challenges.cloudflare.com/script.js',
    'https://challenges.cloudflare.com:8443/script.js', 'https://challenges.cloudflare.com.evil.test/script.js',
    'https://evil.challenges.cloudflare.com/script.js', 'https://evil.cloudflareinsights.com/script.js',
    'https://127.0.0.1/metadata', 'http://169.254.169.254/', 'file:///etc/passwd', 'data:text/javascript,alert(1)']) {
    await assert.rejects(validateResourceDestination(url), { code: 'REJECTED_URL' });
  }
});
