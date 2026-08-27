import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { SupportStore } from './data.js';
import { SkillRegistry } from './skills.js';
import { createSupportServer, SERVER_NAME, SERVER_VERSION } from './server.js';

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);
const MCP_PATH = '/mcp';

/**
 * Demo state lives for the lifetime of the process and is shared by every
 * request, so refunds and escalations created through one Playground session
 * are visible to the next.
 */
const store = new SupportStore();
const registry = new SkillRegistry();

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, skills: registry.size });
});

/**
 * Stateless Streamable HTTP: a fresh transport and MCP server per request, over
 * shared in-memory state. Nothing is kept per session, so there are no session
 * headers to manage and no session state to go stale.
 */
async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const requestId = randomUUID().slice(0, 8);
  const method = typeof req.body?.method === 'string' ? req.body.method : '(no method)';
  console.log(`[${requestId}] ${req.method} ${MCP_PATH} -> ${method}`);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createSupportServer({ store, registry });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`[${requestId}] request failed:`, error instanceof Error ? error.message : error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: req.body?.id ?? null
      });
    }
  }
}

app.post(MCP_PATH, (req, res) => {
  void handleMcpRequest(req, res);
});

// Stateless mode supports neither the GET listening stream nor DELETE teardown.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This server runs stateless Streamable HTTP; use POST.' },
    id: null
  });
};
app.get(MCP_PATH, methodNotAllowed);
app.delete(MCP_PATH, methodNotAllowed);

const httpServer = app.listen(PORT, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION}`);
  console.log(`MCP endpoint:  http://localhost:${PORT}${MCP_PATH}`);
  console.log(`Health check:  http://localhost:${PORT}/healthz`);
  console.log(`Skills served: ${registry.size} (io.modelcontextprotocol/skills)`);
});

function shutdown(signal: string): void {
  console.log(`\nReceived ${signal}, shutting down.`);
  httpServer.close(error => {
    if (error) {
      console.error('Error during shutdown:', error.message);
      process.exit(1);
    }
    process.exit(0);
  });
  // Do not hang forever on lingering sockets.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
