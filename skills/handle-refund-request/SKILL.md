---
name: handle-refund-request
description: Guides an agent through refund, delivery issue, and escalation decisions using the support server's tools. Use it when a customer asks for a refund, reports a damaged or wrong item, reports a delivered order as missing, or asks what can be done about an order problem.
license: Apache-2.0
metadata:
  version: 1.0.0
---

# Handle a refund request

Operational instructions for handling e-commerce support requests with the
`skills-over-mcp-support-demo` server. Follow them in order. The server's tools
are the only source of order facts.

## When to use this skill

Use it whenever the user:

- requests a refund,
- reports a damaged item,
- reports receiving the wrong item,
- reports that an order marked delivered is missing,
- asks what can be done about a problem with an order.

## Step 1 — Get an order ID

If the user has not given an order ID, ask for it before calling any tool.

Never call `list_orders` to guess which order belongs to the user. `list_orders`
is a demo convenience tool for browsing the sample data; it is not part of this
workflow.

## Step 2 — Always call `get_order` first

Once an order ID is available, call `get_order` with it before deciding
anything. Do this even if the user's opening message already states what is
wrong and what they want.

Never invent order details. Never restate a fact differently from what the
server returned. Tool results are authoritative.

## Step 3 — Consult the policy only when you need it

`refund-policy.md` is the source of truth for eligibility rules. Read it lazily:
do not read it at the start of the conversation and do not read it just because
this skill was loaded. Read it at the moment you actually need to verify an
eligibility rule — typically after `get_order` returns and before you tell the
user whether a refund is possible. Read it once per conversation; do not re-read
it for each order.

It is a sibling resource of this file: resolve the relative path
`refund-policy.md` against this skill's directory and read that resource.

## Step 4 — Decide from the order state

Match the `get_order` result to exactly one case below.

### Order not found

- Tell the user the order was not found.
- Do not call `create_refund`.
- Do not call `escalate_case`.

### Already refunded (`alreadyRefunded: true`)

- Tell the user the refund was already processed and give the existing
  `refundId`.
- Do not call `create_refund` again.
- Do not create an escalation unless the user reports a separate, still
  unresolved problem.

### Still in transit (`status: "in_transit"`)

- Explain the current status and the estimated delivery date.
- Do not create a refund merely because the package has not arrived yet.
- Escalate only if the user reports a separate issue that needs manual review,
  and in that case call `escalate_case` with `conflictsWithRecord: true`.

### Delivered correctly, no reported issue (`deliveryResult: "correct"`)

- Explain what the order record shows.
- Do not create a refund or an escalation automatically. This holds whether the
  order is inside or outside the refund window — being older than 30 days is not
  by itself a reason to do anything.
- If the user supplies new information that conflicts with the record (for
  example: "it actually arrived cracked"), call `escalate_case` with
  `conflictsWithRecord: true`. Do not attempt to modify the order facts.

### Damaged or wrong item, inside the refund window

(`deliveryResult` is `damaged` or `wrong_item`, and `withinRefundWindow` is
`true`.)

- Explain that the order appears eligible for a refund, citing the order-specific
  facts `get_order` returned.
- Ask the user for explicit confirmation before creating the refund.
- **Stop and wait for the user's answer.** End your turn there.
- Call `create_refund` only after the user clearly confirms in a later message.
- An opening message such as "I want a refund" is **not** confirmation. First
  retrieve the order, explain the order-specific eligibility result, then obtain
  explicit confirmation.

### Damaged or wrong item, outside the refund window

(`withinRefundWindow` is `false`.)

- Do not call `create_refund`.
- Call `escalate_case` with a reason describing the situation.
- Explain that the case needs manual review because it falls outside the 30-day
  window.

### Delivered but reported missing (`deliveryResult: "missing"`)

- Never issue an automatic refund.
- Call `escalate_case` for investigation.
- Explain that the case has been sent for manual investigation.

## Step 5 — Report the outcome

- State plainly what happened.
- Include the `refundId` or `escalationId` returned by the tool.
- Never claim success unless the corresponding tool call actually succeeded. If a
  tool returns an error, report the error and stop.

## Hard rules

- Never call both `create_refund` and `escalate_case` for the same issue.
- Never call `create_refund` without a separate, explicit user confirmation.
- Never set `conflictsWithRecord: true` unless the user has reported facts that
  contradict the stored order record.
- Never use `list_orders` to identify a user's order.
