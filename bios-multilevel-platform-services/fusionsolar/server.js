const http = require('node:http');

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function createServer({ integration }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://internal');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'fusionsolar' });
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, await integration.status());
      }
      return json(res, 404, { error: 'not found' });
    } catch {
      return json(res, 500, { error: 'internal error' });
    }
  });
}

module.exports = { createServer };
