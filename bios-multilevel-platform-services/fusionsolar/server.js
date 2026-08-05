const http = require('node:http');
const { OAuthRouteNotFoundError } = require('./integration');

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
      if (req.method === 'GET' && url.pathname === '/oauth/fusionsolar/start') {
        try {
          const location = await integration.startUrl(url.searchParams.get('setup_token') || '');
          res.writeHead(302, {
            Location: location,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          });
          return res.end();
        } catch (error) {
          if (error instanceof OAuthRouteNotFoundError) {
            return json(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
          }
          throw error;
        }
      }
      if (req.method === 'GET' && url.pathname === '/oauth/fusionsolar/callback') {
        const result = await integration.completeCallback(url.searchParams);
        res.writeHead(result.ok ? 200 : 400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(
          result.ok
            ? '<h1>FusionSolar authorization completed</h1>'
            : '<h1>FusionSolar authorization failed</h1>',
        );
      }
      return json(res, 404, { error: 'not found' });
    } catch {
      return json(res, 500, { error: 'internal error' });
    }
  });
}

function createShutdown({ server, integration }) {
  let shutdownPromise = null;
  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    integration.stopScheduler();
    const serverClosed = new Promise((resolve) => server.close(resolve));
    shutdownPromise = Promise.all([serverClosed, integration.close()]).then(() => undefined);
    return shutdownPromise;
  };
}

async function main() {
  const { loadConfig } = require('./config');
  const { buildIntegration } = require('./integration');
  const config = loadConfig();
  const integration = await buildIntegration(config);
  const server = createServer({ config, integration });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  integration.startScheduler();

  const shutdown = createShutdown({ server, integration });
  const handleSignal = () => {
    shutdown().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = { createServer, createShutdown, main };
