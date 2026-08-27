# skills-over-mcp-support-demo

A working e-commerce support MCP server that demonstrates **Skills over MCP**
(SEP-2640) over Streamable HTTP, built for testing in
[MCPJam](https://github.com/MCPJam/inspector).

## What Skills over MCP means

An MCP server has always been able to give an agent *actions* — tools it can
call. It has had no good way to ship the *know-how*: the workflow that says
which tool to call, in what order, under which conditions, and when to stop and
ask the user.

Skills over MCP fixes that. A **skill** is a folder of Markdown — a `SKILL.md`
plus any supporting files — that the server publishes as ordinary MCP
*resources*. The agent discovers what skills a server has (`skills/list`), gets
one skill's manifest with a SHA-256 digest and byte size for each of its files
(`skills/get`), and then reads those files individually with the standard
`resources/read` — pulling in the deep detail only at the moment it needs it.
That last part is **progressive disclosure**: the agent loads `SKILL.md` when it
starts handling a refund, and only reads `refund-policy.md` when it actually has
to check an eligibility rule.

### Tools vs. skills

| | Tools | Skills |
| --- | --- | --- |
| What they are | Callable functions | Instructional content |
| What they do | **Perform** an action | **Teach** how and when to combine actions |
| Example here | `create_refund` creates a refund | `handle-refund-request` says: never refund without an explicit confirmation, escalate a missing package instead of refunding it |
| Delivered as | `tools/list` + `tools/call` | `skills/list` + `skills/get` + `resources/read` |

The demo makes the split concrete. The four tools happily enforce their own
server-side rules but know nothing about conversation flow. The skill supplies
the flow.

## SEP-2640 revision targeted

This implementation follows **[modelcontextprotocol#2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)
at commit [`a3e147ca2710f68214247aecc729731ee1ae8d03`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/a3e147ca2710f68214247aecc729731ee1ae8d03/seps/2640-skills-extension.md)**
(PR head as of 2026-08-25), which is the source of truth for the spec.

The synced baseline in
[`experimental-ext-skills`](https://github.com/modelcontextprotocol/experimental-ext-skills)
(`docs/sep-draft-skills-extension.md` at `9f55cd349932ba00fc18402873c9eb2d2c2e78cb`,
a copy of upstream `0eb05fe`) is **older** than the PR head and was not used as the
implementation target. The two differ materially: the PR head adds a required
`size` field to every `resources` entry, replaces the "omit `resources` for
dynamic skills" rule with an explicit `"resources": "dynamic"` marker, adds the
per-skill limits table (512 entries / 16 MiB), and shows `resultType` on list
results. This server implements the newer PR-head shape.

The suggested fallback baseline `d7490ecd1a250f7bc8c3ebb0d65450dfec274bad` was
**not** used, since a newer revision resolved.

**SEP-2640 is still a Draft and is evolving.** This demo follows the version
available at implementation time (2026-08-27). If the spec has moved on, the
method names, field names, or capability shape below may no longer match.

### What this implements

- Capability declaration in `initialize`:
  `capabilities.extensions["io.modelcontextprotocol/skills"] = { "directoryRead": true }`
- `skills/list` — paginated (opaque base64url cursor), returns complete skill
  entries with verbatim `frontmatter` and a full `resources` manifest.
- `skills/get` — returns one skill's entry by URI; `-32602` for a URI the server
  does not serve as a skill.
- `resources/directory/read` — the optional directory-listing method, gated
  behind the `directoryRead` setting.
- `resources/read` — serves skill files with correct MIME types.
- `resources/list` — resource metadata for each skill file; `SKILL.md` takes its
  `name` and `description` from the frontmatter, per the SEP's Resource Metadata
  section.
- URI convention `skill://<skill-name>/<file-path>`, with the final skill-path
  segment equal to the `name` in the `SKILL.md` frontmatter.
- SHA-256 digests (`sha256:<64 hex>`) and byte `size` for every declared file.

There is **no fallback path**. The skill content is not exposed as a tool or as
a non-`skill://` resource. If the extension does not work, the demo fails
visibly.

## Requirements

- Node.js >= 20.11 (developed and tested on Node 24)
- npm
- No database, no auth, no external APIs. All state is in memory and lives only
  for the lifetime of the process.

## Install

```bash
npm install
```

## Develop

```bash
npm run dev        # tsx watch, restarts on change
```

## Build and run

```bash
npm run build      # tsc -> build/
npm start          # node build/src/index.js
```

```bash
PORT=4000 npm start   # the port is configurable
```

## Test

```bash
npm test           # builds, then runs node:test over build/tests/
```

## Connect from MCPJam

Start the server, then in MCPJam add a server with:

- **Transport:** Streamable HTTP
- **URL:** `http://localhost:3001/mcp`

That is the whole configuration — no headers, no auth. A health endpoint is at
`http://localhost:3001/healthz` if you want to confirm the process is up first.

The transport runs **stateless**: every POST is handled independently and no
`Mcp-Session-Id` is issued. `GET /mcp` and `DELETE /mcp` return 405 by design.
The demo data is process-global, so refunds you create in one Playground turn
are visible in the next.

## Verify the tools

In MCPJam's **Tools** tab you should see four tools. Quick checks:

1. `list_orders` with no arguments → 8 orders.
2. `get_order` with `{"orderId": "order_1042"}` → damaged, delivered 5 days ago,
   `withinRefundWindow: true`.
3. `create_refund` with `{"orderId": "order_2048", "reason": "damaged"}` →
   **error** `outside_refund_window`. Server-side rules hold even when a tool is
   called directly.
4. `escalate_case` with `{"orderId": "order_6104", "reason": "unhappy"}` →
   **error** `record_shows_no_problem`. Add `"conflictsWithRecord": true` and it
   succeeds.

## Verify skill discovery and skill files

In MCPJam's Skills/Resources view, or by curl:

```bash
call() { curl -s -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -X POST http://localhost:3001/mcp -d "$1" | tr -d '\r' | sed -n 's/^data: //p'; }

# 1. The extension is declared
call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# 2. Enumerate skills
call '{"jsonrpc":"2.0","id":2,"method":"skills/list","params":{}}'

# 3. One skill's manifest
call '{"jsonrpc":"2.0","id":3,"method":"skills/get","params":{"uri":"skill://handle-refund-request/SKILL.md"}}'

# 4. Read the two skill files
call '{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"skill://handle-refund-request/SKILL.md"}}'
call '{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"skill://handle-refund-request/refund-policy.md"}}'

# 5. Directory listing (optional method, declared via directoryRead)
call '{"jsonrpc":"2.0","id":6,"method":"resources/directory/read","params":{"uri":"skill://handle-refund-request"}}'

# 6. Path traversal is rejected with -32602
call '{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"skill://handle-refund-request/../../etc/passwd"}}'
```

Only URIs that appear in a skill's manifest resolve. A traversal attempt, an
undeclared file, or a `file://` URI misses the manifest map and is rejected —
no filesystem path is ever built from client input.

## Test in the MCPJam Playground

Connect the server, make sure the `handle-refund-request` skill is loaded/enabled
for the session, then send the prompts below.

### Eligible damaged order

```text
My order order_1042 arrived damaged. Can you help me get a refund?
```

Expected: loads or uses `handle-refund-request` → calls `get_order` → explains
eligibility → **asks for confirmation** → does **not** call `create_refund` yet.

Then reply:

```text
Yes, please process the refund.
```

Expected: calls `create_refund` and returns the refund ID.

### Outside the refund window

```text
Order order_2048 arrived damaged and I want a refund.
```

Expected: `get_order` → `escalate_case`. No `create_refund`.

### Already refunded

```text
Can you refund order_3091?
```

Expected: `get_order` → explains it was already refunded as `refund_3091`. No
further action tool.

### Missing delivery

```text
Order order_4177 says delivered, but I never received it.
```

Expected: `get_order` → `escalate_case`. No `create_refund`.

### Wrong item

```text
I received the wrong product for order_5230. I want a refund.
```

Expected: `get_order` → asks for confirmation → calls `create_refund` only after
a separate confirmation message.

### Normal delivered order

```text
Can you check whether anything is wrong with order_6104?
```

Expected: `get_order` → explains it was delivered correctly. No refund, no
escalation.

### Normal order outside the window

```text
Check order_7285 and tell me whether any action is needed.
```

Expected: `get_order` → explains no issue is recorded. Does **not** escalate
merely because the order is older than 30 days.

### In-transit order

```text
Where is order_8362? Should I request a refund?
```

Expected: `get_order` → explains it is still in transit. No refund, no
escalation.

### Invalid order

```text
Please refund order_9999.
```

Expected: `get_order` → reports the order was not found. No refund, no
escalation.

### Manual test: confirmation gating

The server cannot enforce or verify that the agent asked for confirmation — the
tool has no way to know what the agent said. That rule lives in `SKILL.md` and
must be checked by hand in the Playground:

- For `order_1042` and `order_5230`, confirm the assistant does **not** call
  `create_refund` on the first turn, even though the opening message already
  asks for a refund.
- Confirm it calls `create_refund` only after a **separate** explicit
  confirmation message.

Everything else in the workflow is covered by the automated tests.

## Demo orders and expected outcomes

All dates derive from a frozen `REFERENCE_NOW` (`2026-06-01T12:00:00.000Z`), so
results never change with the wall clock.

| Order | Customer | Product | Status | Delivery result | Timing | Already refunded | Expected outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `order_1042` | Alex Johnson | Wireless Headphones | delivered | damaged | 5 days ago | no | **Eligible.** Ask for explicit confirmation, then `create_refund`. |
| `order_2048` | Sam Rivera | Mechanical Keyboard | delivered | damaged | 45 days ago | no | **Outside the window.** `escalate_case`. |
| `order_3091` | Taylor Kim | USB-C Dock | delivered | damaged | 7 days ago | yes (`refund_3091`) | **Already refunded.** Explain; no refund, no escalation. |
| `order_4177` | Jordan Smith | Smartwatch | delivered | reported missing | 2 days ago | no | **Manual investigation.** `escalate_case`; never auto-refund. |
| `order_5230` | Casey Brown | Laptop Stand (received Tablet Stand) | delivered | wrong item | 3 days ago | no | **Eligible.** Ask for explicit confirmation, then `create_refund`. |
| `order_6104` | Morgan Lee | Webcam | delivered | correct | 6 days ago | no | **No issue on record.** Explain; escalate only on conflicting new information. |
| `order_7285` | Jamie Wilson | External SSD | delivered | correct | 35 days ago | no | **No action.** Being outside the window is not itself a reason to act. |
| `order_8362` | Riley Davis | Gaming Mouse | in_transit | n/a | ETA +3 days | no | **In transit.** Explain; no refund, no escalation. |

## Project layout

```text
.
├── src/
│   ├── index.ts      # Express + Streamable HTTP, signal handling
│   ├── server.ts     # MCP server: tools, SEP-2640 request handlers, capability
│   ├── tools.ts      # Tool logic and server-side eligibility rules
│   ├── data.ts       # Frozen REFERENCE_NOW, seed orders, in-memory store
│   └── skills.ts     # Skill registry: frontmatter, digests, sizes, URI mapping
├── skills/
│   └── handle-refund-request/
│       ├── SKILL.md
│       └── refund-policy.md
└── tests/
    ├── support.test.ts   # tools, store, skill registry
    └── protocol.test.ts  # spawns the server, drives it with the SDK client
```

## Known limitations

- **The MCP TypeScript SDK (1.30.0) has no Skills-extension support.** There are
  no types, schemas, or helpers for `skills/list`, `skills/get`, or
  `resources/directory/read`. All three are implemented as low-level
  `setRequestHandler` calls with schemas transcribed from the SEP text. The SDK
  *does* support SEP-2133 extension capability declaration, so the capability
  itself is declared through the normal capabilities object.
- **`ttlMs` / `cacheScope` are not emitted.** The SEP says `skills/list` carries
  the base protocol's list-caching attributes ([SEP-2549]) in protocol versions
  **2026-07-28 and later**. The SDK's latest supported version is `2025-11-25`,
  so that version cannot be negotiated and those fields are omitted rather than
  faked.
- **`resultType: "complete"` is emitted on a best-effort basis.** It appears in
  every `skills/list`, `skills/get`, and `resources/directory/read` example in
  the current PR text, but the SEP does not define its semantics in its own
  field tables — it comes from the base protocol. The value is set to
  `"complete"` because this server enumerates its whole catalog.
- **The `"resources": "dynamic"` form is not exercised.** This server's skill is
  static and always publishes a full manifest with digests and sizes.
- **No `notifications/skills/list_changed`.** The current SEP text defines no
  such notification, and this demo's skill set is fixed at startup. The registry
  is loaded once in one place, so adding change notifications later is a local
  change.
- **YAML frontmatter parsing is a deliberate subset.** `src/skills.ts` parses
  top-level scalars and one level of nesting (enough for `name`, `description`,
  `license`, `metadata.*`) and throws on anything else, rather than risk
  publishing `frontmatter` that differs from the file — which the SEP forbids.

### Ambiguities encountered

- `resultType` is shown in every example but never specified in this SEP's own
  field tables; its allowed values and whether it is required are inherited from
  the base protocol rather than stated here.
- The SEP explicitly leaves open whether `skills/get` results should carry the
  base protocol's caching attributes.
- The SEP is written mostly as host obligations (digest verification,
  frontmatter comparison, lazy retrieval, content-bound approval). Whether
  MCPJam performs those checks is a client-side matter this server cannot
  influence; it publishes correct digests, sizes, and verbatim frontmatter so
  that a conforming host's checks pass.

## Troubleshooting

**MCPJam cannot connect.**
Check `curl http://localhost:3001/healthz`. If nothing answers, the server is not
running or is on another port (`PORT=...`). The URL must include the `/mcp` path.

**"Method not allowed" on connect.**
The transport is stateless, so `GET /mcp` (the SSE listening stream) returns 405.
Make sure MCPJam is set to **Streamable HTTP**, not the deprecated HTTP+SSE
transport.

**`406 Not Acceptable` when testing with curl.**
Streamable HTTP requires `Accept: application/json, text/event-stream` on POST.
Use the `call()` helper above.

**No skills appear in MCPJam.**
Confirm the `initialize` response carries
`capabilities.extensions["io.modelcontextprotocol/skills"]`. If it does and
MCPJam still shows nothing, the client is likely on an older or newer SEP-2640
revision than the one pinned above — the method names and field shapes have
changed more than once during the draft.

**`-32602` reading a skill file.**
Only files listed in the skill's manifest are readable. Check the exact URI
against `skills/get`; the path is case-sensitive and there is no trailing slash
on directory URIs.

**`Cannot find module` after `npm start`.**
Run `npm run build` first — `npm start` runs the compiled output in `build/`.

**Type errors on install.**
The project pins `@modelcontextprotocol/sdk@1.30.0` and uses Zod v4, which is
what that SDK version builds against. Mixing in Zod v3 will produce schema type
errors.

[SEP-2549]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2549
