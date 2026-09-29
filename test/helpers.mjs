import http from 'node:http';

/** A fake gateway + Authn on 127.0.0.1. mode picks behaviour; `log` records requests. */
export function startServer(mode = 'ok') {
  const blobs = new Map(); const log = []; let biscuits = 0;
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      log.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, ct: req.headers['content-type'] ?? null });
      const port = server.address().port;
      if (req.method === 'POST' && req.url === '/v1/biscuit/token') {
        const j = (() => { try { return JSON.parse(body.toString()); } catch { return {}; } })();
        if (req.headers.authorization !== 'Bearer kb_sa_good' || j.tenantId !== 't_abc') { res.writeHead(401); return res.end('{}'); }
        biscuits += 1;
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ authorization: `Biscuit tok${biscuits}`, expiresIn: 900 }));
      }
      if (req.method === 'PUT') {
        if (mode === 'put-redirect') { res.writeHead(308, { location: `http://127.0.0.1:${port}/elsewhere` }); return res.end(); }
        if (req.headers['content-type'] !== 'application/vnd.ipld.raw') { res.writeHead(415); return res.end(); }
        if (!/^Biscuit tok\d+$|^Bearer good$/.test(req.headers.authorization ?? '')) { res.writeHead(401); return res.end(); }
        blobs.set(req.url.split('/').pop(), body); res.writeHead(201); return res.end();
      }
      if (req.method === 'GET') {
        const cid = req.url.split('/').pop();
        if (req.url.startsWith('/blob/')) { const b = blobs.get(cid); res.writeHead(b ? 200 : 404); return res.end(b); }
        if (mode === 'redirect') { res.writeHead(301, { location: `/blob/${cid}` }); return res.end(); }
        if (mode === 'redirect-off') { res.writeHead(301, { location: `http://localhost:${port}/blob/${cid}` }); return res.end(); }
        if (mode === 'loop') { res.writeHead(301, { location: req.url }); return res.end(); }
        const b = blobs.get(cid);
        if (!b) { res.writeHead(404); return res.end(); }
        res.writeHead(200); return res.end(mode === 'corrupt' ? Buffer.from('tampered') : mode === 'big' ? Buffer.alloc(2048, 1) : b);
      }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, log, blobs, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

export const baseCfg = (origin) => ({ url: origin, readUrl: origin, prefix: '/ipfs/', authnUrl: origin,
  tenantId: null, storage: null, permissions: null, authCmd: null, saToken: null, staticAuth: null });
