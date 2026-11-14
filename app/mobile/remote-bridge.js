'use strict';
// Fix85: tailnet-only HTTPS access to Nestrill Mobile, via Tailscale Serve.
// This bridge listens only on 127.0.0.1:18768. Never forwards PC API paths.
// Requires the existing authenticated Fix84A+ Mobile server on a private LAN IP.
const http = require('node:http');
const os = require('node:os');

const PORT = 18768;
const BACKEND_PORT = 8768;
const lanHost = String(process.argv[2] || '');
const fqdn = String(process.argv[3] || '').replace(/\.$/, '').toLowerCase();
const localIPs = new Set(Object.values(os.networkInterfaces()).flatMap(a => (a || [])
  .filter(v => v.family === 'IPv4' && !v.internal)
  .map(v => v.address)));
if (!localIPs.has(lanHost) || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(lanHost)) {
  console.error('[FAIL] Invalid local private IPv4'); process.exit(2);
}
if (!/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(fqdn) || !fqdn.endsWith('.ts.net')) {
  console.error('[FAIL] Invalid Tailscale DNS name'); process.exit(2);
}
const remoteOrigin = `https://${fqdn}`;
const internalOrigin = `http://${lanHost}:${BACKEND_PORT}`;
const reject = (res, status, message) => {
  res.writeHead(status, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'}); res.end(message);
};
const hop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailer','transfer-encoding','upgrade','forwarded','x-forwarded-for',
  'x-forwarded-host','x-forwarded-proto','x-real-ip','proxy-connection']);
function stripHeaders(input) {
  const output = {};
  for (const [key,value] of Object.entries(input)) if (!hop.has(key.toLowerCase())) output[key] = value;
  return output;
}
const srv = http.createServer((req, res) => {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    return reject(res, 403, 'Local bridge only');
  }
  if (req.method === 'GET' && req.url === '/_nestrill_bridge_health') {
    res.writeHead(200, {'content-type':'application/json', 'cache-control':'no-store'});
    return res.end(JSON.stringify({app:'Nestrill-Remote-Bridge', active:true}));
  }
  if (!['GET','POST'].includes(req.method)) return reject(res, 405, 'Method not allowed');
  let target;
  try { target = new URL(req.url, remoteOrigin); } catch { return reject(res, 400, 'Invalid URL'); }
  if (!target.pathname.startsWith('/mobile/') || target.origin !== remoteOrigin) {
    return reject(res, 404, 'Not found');
  }
  const host = String(req.headers.host || '').toLowerCase();
  // Tailscale Serve can preserve the original host or rewrite to the proxy target.
  if (![fqdn, `${fqdn}:443`, `127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)) {
    return reject(res, 403, 'Unexpected host');
  }
  // The real HTTPS origin must match. Do not turn other origins into trusted POSTs.
  if (req.method === 'POST' && ![remoteOrigin, `${remoteOrigin}:443`].includes(req.headers.origin)) {
    return reject(res, 403, 'Invalid origin');
  }
  if (req.method === 'POST' && Number(req.headers['content-length'] || 0) > 8192) {
    return reject(res, 413, 'Request too large');
  }
  const headers = stripHeaders(req.headers);
  headers.host = `${lanHost}:${BACKEND_PORT}`;
  if (req.method === 'POST') headers.origin = internalOrigin;
  else delete headers.origin;
  const upstream = http.request({hostname:lanHost, port:BACKEND_PORT, method:req.method,
    path:target.pathname + target.search, headers, timeout:10000}, upstreamResponse => {
    const responseHeaders = stripHeaders(upstreamResponse.headers);
    if (responseHeaders['set-cookie']) {
      // Browser-facing endpoint is HTTPS; prevent the PIN session cookie from ever using HTTP.
      responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(v =>
        /(?:^|;)\s*Secure(?:;|$)/i.test(v) ? v : `${v}; Secure`);
    }
    responseHeaders['cache-control'] = 'no-store';
    res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Backend timeout')));
  upstream.on('error', () => { if (!res.headersSent) reject(res,502,'Nestrill Mobile is unavailable'); else res.destroy(); });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});
srv.on('error', err => { console.error('[FAIL] Remote bridge:', err.message); process.exitCode = 1; });
srv.listen(PORT, '127.0.0.1', () => console.log(`[PASS] Remote bridge: 127.0.0.1:${PORT} -> ${lanHost}:${BACKEND_PORT}`));
