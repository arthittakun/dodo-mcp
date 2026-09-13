#!/usr/bin/env node
/**
 * Local reverse-proxy fixture (spec §H): stands in for the user-managed
 * Cloudflare named tunnel so the full OAuth + MCP flow can be exercised
 * end-to-end WITHOUT any real domain or Cloudflare account. It forwards ALL
 * paths (not just /mcp) to DODO, exactly as the runbook requires.
 *
 * Usage:
 *   1. dodo init --public-url http://127.0.0.1:8788 --dangerously-allow-insecure-http
 *   2. dodo start          # binds 127.0.0.1:21730
 *   3. node examples/reverse-proxy-fixture.mjs 8788 21730
 *
 * This is a TEST fixture (plain HTTP). A real deployment uses HTTPS via your
 * own tunnel; DODO never manages the tunnel.
 */
import http from 'node:http';

const listenPort = Number(process.argv[2] ?? 8788);
const targetPort = Number(process.argv[3] ?? 21730);

const server = http.createServer((req, res) => {
  const proxyReq = http.request(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'http', 'x-forwarded-host': req.headers.host } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    res.writeHead(502).end('bad gateway (is dodo running?)');
  });
  req.pipe(proxyReq);
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`reverse-proxy fixture: http://127.0.0.1:${listenPort} → 127.0.0.1:${targetPort} (all paths)`);
});
