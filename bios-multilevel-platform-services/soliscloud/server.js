const http = require('node:http');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function createServer({ integration }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://internal');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'soliscloud' });
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
  const server = createServer({ integration });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  console.log(`soliscloud service listening on ${config.port}`);
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
  main().catch((error) => {
    console.error('soliscloud service failed to start:', error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { createServer, createShutdown, main };
