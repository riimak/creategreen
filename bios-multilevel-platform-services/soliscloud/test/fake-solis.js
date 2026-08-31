const crypto = require('node:crypto');
const http = require('node:http');

// Minimal SolisCloud stand-in: verifies the HMAC-SHA1 signature exactly the
// way the real endpoint does (plain "application/json" in the string-to-sign)
// and serves canned station/inverter/day payloads.
function createFakeSolis({ keyId, keySecret, data = {} }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const contentMd5 = crypto.createHash('md5').update(body, 'utf8').digest('base64');
      const toSign = ['POST', contentMd5, 'application/json', req.headers.date, req.url].join('\n');
      const expected = `API ${keyId}:${crypto.createHmac('sha1', keySecret).update(toSign, 'utf8').digest('base64')}`;
      if (req.headers.authorization !== expected || req.headers['content-md5'] !== contentMd5) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 403, error: 'Forbidden', message: 'wrong sign' }));
        return;
      }
      calls.push({ path: req.url, body: JSON.parse(body) });
      const handler = data[req.url];
      const payload = typeof handler === 'function' ? handler(JSON.parse(body)) : handler;
      if (!payload) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  return {
    calls,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function pageResponse(records) {
  return {
    success: true,
    code: '0',
    msg: 'success',
    data: { page: { records, pages: 1, current: 1, total: records.length } },
  };
}

function dayResponse(points) {
  return { success: true, code: '0', msg: 'success', data: points };
}

module.exports = { createFakeSolis, pageResponse, dayResponse };
