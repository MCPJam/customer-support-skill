import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { SupportStore } from './data.js';
import {
  createRefund,
  createRefundInputSchema,
  escalateCase,
  escalateCaseInputSchema,
  getOrder,
  getOrderInputSchema,
  listOrders,
  type ToolOutcome
} from './tools.js';
import { InvalidSkillParams, SkillRegistry, SKILLS_EXTENSION_ID } from './skills.js';

export const SERVER_NAME = 'skills-over-mcp-support-demo';
export const SERVER_VERSION = '1.0.0';

/**
 * SEP-2640 request schemas.
 *
 * The SDK (1.30.0) ships no types for this extension, so the three methods are
 * declared here exactly as the SEP defines them.
 */
const SkillsListRequestSchema = z.object({
  method: z.literal('skills/list'),
  params: z.optional(
    z.object({ cursor: z.optional(z.string()) }).loose()
  )
});

const SkillsGetRequestSchema = z.object({
  method: z.literal('skills/get'),
  params: z.object({ uri: z.string() }).loose()
});

const ResourcesDirectoryReadRequestSchema = z.object({
  method: z.literal('resources/directory/read'),
  params: z.object({ uri: z.string(), cursor: z.optional(z.string()) }).loose()
});

const SERVER_INSTRUCTIONS = [
  'E-commerce support demo server.',
  '',
  'Tools perform actions on orders (list_orders, get_order, create_refund, escalate_case).',
  'The skill served at skill://handle-refund-request/SKILL.md teaches how and when to',
  'combine them. Load that skill before handling any refund, damage, wrong-item, missing-',
  'delivery, or general "what can be done about my order" request.'
].join('\n');

function toToolResult(outcome: ToolOutcome) {
  return {
    content: [{ type: 'text' as const, text: `${outcome.message}\n\n${JSON.stringify(outcome.data, null, 2)}` }],
    structuredContent: { message: outcome.message, ...outcome.data },
    isError: outcome.isError
  };
}

export interface SupportServerDeps {
  store: SupportStore;
  registry: SkillRegistry;
}

export function createSupportServer({ store, registry }: SupportServerDeps): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        resources: {},
        // SEP-2133 extension negotiation. Declaring the extension commits this
        // server to skills/list and skills/get; directoryRead additionally
        // commits it to resources/directory/read.
        extensions: {
          [SKILLS_EXTENSION_ID]: { directoryRead: true }
        }
      }
    }
  );

  registerTools(mcp, store);
  registerSkillHandlers(mcp, registry);
  return mcp;
}

function registerTools(mcp: McpServer, store: SupportStore): void {
  mcp.registerTool(
    'list_orders',
    {
      title: 'List demo orders',
      description:
        'List every demo order with its status, delivery result, refund status and escalation status. Demo convenience only — never use it to guess which order belongs to a user.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => toToolResult(listOrders(store))
  );

  mcp.registerTool(
    'get_order',
    {
      title: 'Get one order',
      description:
        'Retrieve the complete current state of one order, including refund-window and eligibility facts computed deterministically from the server reference date.',
      inputSchema: getOrderInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async args => toToolResult(getOrder(store, args))
  );

  mcp.registerTool(
    'create_refund',
    {
      title: 'Create a refund',
      description:
        'Create a refund for an eligible order. Rejects orders that are unknown, in transit, delivered correctly, outside the refund window, already refunded, or that require manual investigation.',
      inputSchema: createRefundInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async args => toToolResult(createRefund(store, args))
  );

  mcp.registerTool(
    'escalate_case',
    {
      title: 'Escalate a case',
      description:
        'Open a manual support case. Returns the existing escalation instead of creating a duplicate. Escalating an order whose record shows no problem requires conflictsWithRecord: true.',
      inputSchema: escalateCaseInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async args => toToolResult(escalateCase(store, args))
  );
}

function registerSkillHandlers(mcp: McpServer, registry: SkillRegistry): void {
  const server = mcp.server;

  server.setRequestHandler(SkillsListRequestSchema, async request => {
    const cursor = request.params?.cursor;
    try {
      const page = registry.list(cursor);
      // `resultType` marks the listing as a complete enumeration, per the SEP's
      // skills/list examples.
      return { resultType: 'complete', ...page };
    } catch (error) {
      throw asMcpError(error);
    }
  });

  server.setRequestHandler(SkillsGetRequestSchema, async request => {
    try {
      return { resultType: 'complete', skill: registry.get(request.params.uri) };
    } catch (error) {
      throw asMcpError(error);
    }
  });

  server.setRequestHandler(ResourcesDirectoryReadRequestSchema, async request => {
    try {
      return { resultType: 'complete', resources: registry.readDirectory(request.params.uri) };
    } catch (error) {
      throw asMcpError(error);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: registry.listResources()
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    try {
      const file = registry.readFile(request.params.uri);
      return {
        contents: [
          {
            uri: file.uri,
            mimeType: file.mimeType,
            text: file.bytes.toString('utf8')
          }
        ]
      };
    } catch (error) {
      throw asMcpError(error);
    }
  });
}

function asMcpError(error: unknown): McpError {
  if (error instanceof InvalidSkillParams) {
    return new McpError(ErrorCode.InvalidParams, error.message);
  }
  if (error instanceof McpError) return error;
  return new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
}
