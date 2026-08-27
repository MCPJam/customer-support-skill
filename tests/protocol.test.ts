/**
 * End-to-end protocol test: starts the real server as a child process and talks
 * to it over Streamable HTTP with the official SDK client.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, '..', 'src', 'index.js');

let child: ChildProcess;

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not become healthy in time');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function connect(): Promise<Client> {
  const client = new Client({ name: 'protocol-test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  return client;
}

const AnyResult = z.object({}).loose();

before(async () => {
  child = spawn(process.execPath, [entrypoint], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth();
});

after(async () => {
  child.kill('SIGTERM');
});

describe('streamable http server', () => {
  test('starts successfully and declares the skills extension on initialize', async () => {
    const client = await connect();
    const capabilities = client.getServerCapabilities() as Record<string, unknown>;
    const extensions = capabilities['extensions'] as Record<string, unknown>;
    assert.ok(extensions, 'server capabilities carry an extensions object');
    assert.deepEqual(extensions['io.modelcontextprotocol/skills'], { directoryRead: true });
    await client.close();
  });

  test('tools/list exposes the four support tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(t => t.name).sort(),
      ['create_refund', 'escalate_case', 'get_order', 'list_orders']
    );
    await client.close();
  });

  test('tools are callable over the transport', async () => {
    const client = await connect();
    const result = (await client.callTool({ name: 'get_order', arguments: { orderId: 'order_1042' } })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    assert.notEqual(result.isError, true);
    const order = result.structuredContent?.['order'] as Record<string, unknown>;
    assert.equal(order['customer'], 'Alex Johnson');
    await client.close();
  });

  test('skills/list returns the handle-refund-request entry', async () => {
    const client = await connect();
    const result = (await client.request({ method: 'skills/list', params: {} }, AnyResult)) as {
      skills: Array<{ uri: string; frontmatter: Record<string, unknown>; resources: Array<{ uri: string; digest: string; size: number }> }>;
      nextCursor?: string;
    };
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]!.uri, 'skill://handle-refund-request/SKILL.md');
    assert.equal(result.skills[0]!.frontmatter['name'], 'handle-refund-request');
    assert.equal(result.skills[0]!.resources.length, 2);
    await client.close();
  });

  test('skills/get returns the same entry and errors on an unknown URI', async () => {
    const client = await connect();
    const result = (await client.request(
      { method: 'skills/get', params: { uri: 'skill://handle-refund-request/SKILL.md' } },
      AnyResult
    )) as { skill: { uri: string; resources: unknown[] } };
    assert.equal(result.skill.uri, 'skill://handle-refund-request/SKILL.md');
    assert.equal(result.skill.resources.length, 2);

    await assert.rejects(
      client.request({ method: 'skills/get', params: { uri: 'skill://nope/SKILL.md' } }, AnyResult),
      (error: { code?: number }) => error.code === -32602
    );
    await client.close();
  });

  test('resources/read serves both skill files and rejects traversal', async () => {
    const client = await connect();
    const skillMd = await client.readResource({ uri: 'skill://handle-refund-request/SKILL.md' });
    assert.match(String((skillMd.contents[0] as { text: string }).text), /^---\nname: handle-refund-request/);
    assert.equal(skillMd.contents[0]!.mimeType, 'text/markdown');

    const policy = await client.readResource({ uri: 'skill://handle-refund-request/refund-policy.md' });
    assert.match(String((policy.contents[0] as { text: string }).text), /# Refund policy/);

    for (const uri of [
      'skill://handle-refund-request/../../etc/passwd',
      'skill://handle-refund-request/undeclared.md',
      'file:///etc/passwd'
    ]) {
      await assert.rejects(
        client.readResource({ uri }),
        (error: { code?: number }) => error.code === -32602,
        `expected -32602 for ${uri}`
      );
    }
    await client.close();
  });

  test('resources/directory/read lists the skill root', async () => {
    const client = await connect();
    const result = (await client.request(
      { method: 'resources/directory/read', params: { uri: 'skill://handle-refund-request' } },
      AnyResult
    )) as { resources: Array<{ name: string; mimeType: string }> };
    assert.deepEqual(result.resources.map(r => r.name).sort(), ['SKILL.md', 'refund-policy.md']);
    await client.close();
  });

  test('an unknown method returns a JSON-RPC error instead of crashing', async () => {
    const client = await connect();
    await assert.rejects(client.request({ method: 'skills/nope', params: {} }, AnyResult));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    await client.close();
  });
});
