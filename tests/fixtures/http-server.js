'use strict';
/**
 * Streamable-HTTP front end for the demo server. Replies to POSTs with either
 * plain JSON or SSE so both response shapes get covered, and issues a session id.
 */

const http = require('node:http');
const { createHandler } = require('./demo-server');

function startHttpServer(options = {}) {
  const mode = options.mode ?? 'json'; // 'json' | 'sse'
  const requireAuth = options.requireAuth ?? false;
  const handle = createHandler();
  const seenHeaders = [];
  let sessionId;

  const server = http.createServer((req, res) => {
    seenHeaders.push({ method: req.method, headers: req.headers });

    if (requireAuth && req.headers.authorization !== 'Bearer s3cret') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET') {
      // No server-initiated stream in this fixture.
      res.writeHead(405).end();
      return;
    }

    if (req.method === 'DELETE') {
      sessionId = undefined;
      res.writeHead(204).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const response = handle(message);
      const headers = { 'content-type': 'application/json' };
      if (message.method === 'initialize') {
        sessionId = 'session-1';
      }
      if (sessionId) {
        headers['mcp-session-id'] = sessionId;
      }

      if (!response) {
        res.writeHead(202, sessionId ? { 'mcp-session-id': sessionId } : {}).end();
        return;
      }

      if (mode === 'sse') {
        res.writeHead(200, {
          ...headers,
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }

      res.writeHead(200, headers);
      res.end(JSON.stringify(response));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        seenHeaders,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          }),
      });
    });
  });
}

module.exports = { startHttpServer };
