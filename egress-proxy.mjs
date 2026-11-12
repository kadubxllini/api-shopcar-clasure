import http from 'node:http';
import net from 'node:net';
import { resolveResourceDestination } from './core.mjs';

// TLS is tunnelled unchanged; frames/workers cannot bypass the destination gate.
export async function startEgressProxy({ resolve = resolveResourceDestination, connect = net.connect } = {}) {
  const sockets = new Set();
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    req.resume();
    res.writeHead(403, { Connection: 'close' });
    res.end();
  });
  server.maxConnections = 64;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(60000, () => socket.destroy());
  };
  server.on('connection', track);
  server.on('connect', async (req, socket, head) => {
    let upstream;
    let deadline;
    const stop = () => { socket.destroy(); upstream?.destroy(); clearTimeout(deadline); };
    socket.once('close', stop);
    try {
      if (!/^[a-z0-9.-]+:443$/i.test(req.url || '')) throw new Error('REJECTED_URL');
      const { addresses } = await resolve(`https://${req.url}/`);
      if (socket.destroyed) return;
      const address = addresses.find(item => item.family === 4) || addresses[0];
      // Connect to this validated address, without performing a second DNS lookup.
      upstream = connect({ host: address.address, family: address.family, port: 443 });
      track(upstream);
      deadline = setTimeout(stop, 60000);
      deadline.unref();
      upstream.setTimeout(5000, stop);
      upstream.once('error', stop);
      upstream.once('close', stop);
      upstream.once('connect', () => {
        if (socket.destroyed) return stop();
        upstream.setTimeout(60000, stop);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveReady(); });
  });
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolveClosed => {
      for (const socket of sockets) socket.destroy();
      server.close(resolveClosed);
    })
  };
}
