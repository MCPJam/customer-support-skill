# Refund policy

Source of truth for eligibility decisions in the `handle-refund-request` skill.

## Refund window

- The standard refund window is **30 days after delivery**.
- The window is computed by the server from the stored delivery date; use the
  `withinRefundWindow` field returned by `get_order`. Do not compute it yourself.

## Automatically refundable inside the window

- Item arrived damaged (`deliveryResult: "damaged"`).
- Customer received the wrong item (`deliveryResult: "wrong_item"`).

Both still require explicit user confirmation before the refund is created.

## Requires manual escalation

- Package marked as delivered but reported missing (`deliveryResult: "missing"`).
- Damaged or incorrect item **outside** the refund window.
- User reports facts that conflict with the stored order record — send
  `conflictsWithRecord: true`.
- Any unclear or otherwise unsupported situation.

## Not automatically refundable

- Orders still in transit (`status: "in_transit"`) are never eligible for an
  automatic refund.
- Correct, undamaged orders (`deliveryResult: "correct"`) are not automatically
  refundable, inside or outside the window.

## Invariants

- An order can be refunded **once**. If `alreadyRefunded` is `true`, report the
  existing `refundId` and take no financial action.
- Financial actions require **explicit confirmation** from the user.
- Creating an internal escalation does not require confirmation in this demo.
- Never create both a refund and an escalation for the same issue.
- An order that is simply old, with no reported problem, needs no action at all.
