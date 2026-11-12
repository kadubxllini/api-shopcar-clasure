import { failure, validateUrl, MAX_HTML } from './core.mjs';

export const DEFAULT_IMPORTER_URL = 'http://127.0.0.1:4381/v1/extract';
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

// The site is the only host that ever receives the site token, so it is validated
// structurally instead of being pinned to one domain: HTTPS, no credentials, no port
// trick, no IP literal. The importer endpoint must stay on loopback.
export function validateWorkerConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(k => !['site', 'siteToken', 'importerToken', 'importerUrl'].includes(k))
    || typeof config.site !== 'string' || !/^[a-f0-9]{64}$/.test(config.siteToken || '')
    || !/^[a-f0-9]{64}$/.test(config.importerToken || '') || config.siteToken === config.importerToken) throw new Error('Invalid worker config');
  const site = new URL(config.site);
  if (site.protocol !== 'https:' || !site.hostname || LOOPBACK.test(site.hostname) || site.hostname === 'localhost'
    || site.username || site.password || site.port || site.pathname !== '/' || site.search || site.hash) throw new Error('Invalid site');
  let importerUrl = DEFAULT_IMPORTER_URL;
  if (config.importerUrl !== undefined) {
    if (typeof config.importerUrl !== 'string') throw new Error('Invalid importer URL');
    const parsed = new URL(config.importerUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK.test(parsed.hostname)
      || parsed.pathname !== '/v1/extract' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid importer URL');
    importerUrl = parsed.origin + parsed.pathname;
  }
  return { ...config, site: site.origin, importerUrl };
}

export async function requestJson(url, body, token, timeout = 15000, fetcher = fetch) {
  const response = await fetcher(url, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_HTML) throw failure('PARSE_FAILED');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let data;
  try { data = JSON.parse(text); } catch { throw failure('UNAVAILABLE'); }
  if (!response.ok) {
    throw failure(['BLOCKED', 'TIMEOUT', 'NOT_FOUND', 'PARSE_FAILED', 'UNAVAILABLE', 'REJECTED_URL'].includes(data?.code)
      ? data.code : 'UNAVAILABLE');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('UNAVAILABLE');
  return data;
}

export async function processNext(config, fetcher = fetch) {
  const endpoint = action => `${config.site}/api.php?action=${action}`;
  const { job } = await requestJson(endpoint('import_claim'), {}, config.siteToken, 15000, fetcher);
  if (job === null) return null;
  if (!job || !/^[a-f0-9]{32}$/.test(job.id || '') || !/^[a-f0-9]{64}$/.test(job.lease || '')) throw failure('UNAVAILABLE');
  let result;
  let code;
  try {
    validateUrl(job.url);
    result = await requestJson(config.importerUrl || DEFAULT_IMPORTER_URL, { url: job.url, adapter: 'shopcar', raw: true }, config.importerToken, 48000, fetcher);
    if (typeof result.html !== 'string' || !result.vehicle || typeof result.vehicle !== 'object'
      || Array.isArray(result.vehicle) || Buffer.byteLength(JSON.stringify(result)) > MAX_HTML - 1024) throw failure('PARSE_FAILED');
  } catch (error) {
    code = error.name === 'TimeoutError' ? 'TIMEOUT' : error.code || 'UNAVAILABLE';
    result = undefined;
  }
  const reply = await requestJson(endpoint('import_result'), { id: job.id, lease: job.lease, result, code }, config.siteToken, 15000, fetcher);
  if (reply.success !== true) throw failure('UNAVAILABLE');
  return code || 'OK';
}
