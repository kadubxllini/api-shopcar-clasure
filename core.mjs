import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_HTML = 5 * 1024 * 1024;
export function failure(code) { return Object.assign(new Error(code), { code }); }
export function validateUrl(value) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw failure('REJECTED_URL');
  let url;
  try { url = new URL(value); } catch { throw failure('REJECTED_URL'); }
  if (url.protocol !== 'https:' || !['shopcar.com.br', 'www.shopcar.com.br'].includes(url.hostname)
    || url.username || url.password || url.port) throw failure('REJECTED_URL');
  url.hash = '';
  return url.href;
}
export async function validateDestination(value) {
  const url = validateUrl(value);
  let timer;
  let addresses;
  try {
    addresses = await Promise.race([lookup(new URL(url).hostname, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('TIMEOUT')), 5000); })]);
  } finally { clearTimeout(timer); }
  // Reject private/reserved destinations, including IPv4-mapped and transition IPv6.
  if (!addresses.length || addresses.some(({ address }) => {
    if (isIP(address) === 6) return !/^[23]/i.test(address)
      || /^(2001:(db8|0|[01][0-9a-f]):|2002:)/i.test(address);
    if (isIP(address) !== 4) return true;
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b));
  })) throw failure('REJECTED_URL');
  return url;
}
export function authorized(header, clients) {
  if (!/^Bearer [a-f0-9]{64}$/.test(header || '')) return null;
  const hash = createHash('sha256').update(header.slice(7)).digest();
  return clients.find(c => /^[a-f0-9]{64}$/.test(c.tokenHash || '')
    && timingSafeEqual(hash, Buffer.from(c.tokenHash, 'hex'))) || null;
}
// Cloudflare injects /cdn-cgi/challenge-platform/scripts/jsd/main.js into legitimate pages,
// so "challenge-platform" alone is not a block signal; the challenge title and cf-chl- are.
export function challengePage(status, html) {
  return [403, 429].includes(status)
    || /<title>\s*(Just a moment|Um momento|Verificando)/i.test(html)
    || /cf-chl-|id="challenge-stage"/i.test(html);
}
export function classify(status, html) {
  if (challengePage(status, html)) throw failure('BLOCKED');
  if ([404, 410].includes(status)) throw failure('NOT_FOUND');
  if (status >= 400) throw failure('UNAVAILABLE');
  if (Buffer.byteLength(html) > MAX_HTML || html.length < 300) throw failure('PARSE_FAILED');
}
export class SerialQueue {
  tail = Promise.resolve();
  pending = 0;
  enqueue(fn) {
    if (this.pending >= 10) return Promise.reject(failure('UNAVAILABLE'));
    this.pending++;
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {}).then(() => new Promise(r => setTimeout(r, 2500))).finally(() => this.pending--);
    return task;
  }
}

export function validateServiceConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(k => !['stateDir', 'port', 'clients', 'executablePath'].includes(k))
    || typeof config.stateDir !== 'string' || !config.stateDir.startsWith('/')
    || (config.executablePath !== undefined && (typeof config.executablePath !== 'string' || !config.executablePath.startsWith('/')))
    || (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535))
    || !Array.isArray(config.clients) || config.clients.length < 1 || config.clients.length > 50) throw new Error('Invalid service config');
  const hashes = new Set();
  for (const client of config.clients) {
    if (!client || typeof client !== 'object' || Object.keys(client).some(k => !['tokenHash', 'adapters', 'rateLimit'].includes(k))
      || !/^[a-f0-9]{64}$/.test(client.tokenHash || '') || hashes.has(client.tokenHash)
      || !Array.isArray(client.adapters) || client.adapters.length !== 1 || client.adapters[0] !== 'shopcar'
      || (client.rateLimit !== undefined && (!Number.isInteger(client.rateLimit) || client.rateLimit < 1 || client.rateLimit > 60))) {
      throw new Error('Invalid client config');
    }
    hashes.add(client.tokenHash);
  }
  return config;
}

export function loadPrivateConfig(path, validate) {
  try { return validate(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new Error('Invalid private configuration'); }
}
