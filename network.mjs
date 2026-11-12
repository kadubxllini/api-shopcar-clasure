import { MAX_HTML, failure, validateDestination } from './core.mjs';

// CDP pauses response headers before following redirects omitted by Playwright routes.
// https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#event-requestPaused
export async function guardPage(context, page, onFailure, validate = validateDestination) {
  const cdp = await context.newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  let requests = 0;
  let redirects = 0;
  let total = 0;
  const received = new Map();
  const fail = code => { onFailure(code); void page.close().catch(() => {}); };
  cdp.on('Fetch.requestPaused', async event => {
    const { requestId, request, resourceType, frameId, responseStatusCode, responseHeaders } = event;
    try {
      if (++requests > 400) { fail('PARSE_FAILED'); return; }
      const length = responseHeaders?.find(header => header.name.toLowerCase() === 'content-length')?.value;
      if (Number(length || 0) > MAX_HTML) { fail('PARSE_FAILED'); return; }
      const location = responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
      // Only the main document redirect matters for SSRF. Third-party hops (including
      // Cloudflare challenge assets) must pass through, or a real page can never load.
      if (resourceType === 'Document' && frameId === frameTree.frame.id
        && responseStatusCode >= 300 && responseStatusCode < 400 && location) {
        if (++redirects > 3) throw failure('REJECTED_URL');
        await validate(new URL(location, request.url).href);
      }
      await cdp.send('Fetch.continueResponse', { requestId });
    } catch (error) {
      if (resourceType === 'Document' && frameId === frameTree.frame.id) onFailure(error.code || 'UNAVAILABLE');
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  cdp.on('Network.responseReceived', ({ response }) => {
    const length = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
    if (Number(length || 0) > MAX_HTML) fail('PARSE_FAILED');
  });
  cdp.on('Network.dataReceived', ({ requestId, dataLength }) => {
    const bytes = (received.get(requestId) || 0) + dataLength;
    received.set(requestId, bytes);
    total += dataLength;
    if (bytes > MAX_HTML || total > MAX_HTML * 4) fail('PARSE_FAILED');
  });
  cdp.on('Network.loadingFinished', ({ requestId }) => received.delete(requestId));
  cdp.on('Network.loadingFailed', ({ requestId }) => received.delete(requestId));
  await cdp.send('Network.enable');
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
  return cdp;
}
