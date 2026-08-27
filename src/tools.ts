import { z } from 'zod';
import {
  daysSinceDelivery,
  isAutoRefundableIssue,
  withinRefundWindow,
  REFERENCE_NOW,
  type Order,
  type SupportStore
} from './data.js';

/** A tool outcome. `isError: true` is surfaced to the model as a tool error. */
export interface ToolOutcome {
  isError: boolean;
  data: Record<string, unknown>;
  message: string;
}

const ok = (message: string, data: Record<string, unknown> = {}): ToolOutcome => ({
  isError: false,
  data,
  message
});

const fail = (code: string, message: string, data: Record<string, unknown> = {}): ToolOutcome => ({
  isError: true,
  data: { code, ...data },
  message
});

/** Everything an agent needs to decide, derived deterministically from REFERENCE_NOW. */
export function describeOrder(order: Order) {
  const elapsed = daysSinceDelivery(order);
  const inWindow = withinRefundWindow(order);
  return {
    orderId: order.orderId,
    customer: order.customer,
    productOrdered: order.productOrdered,
    productReceived: order.productReceived ?? order.productOrdered,
    receivedDifferentProduct: order.productReceived !== undefined,
    status: order.status,
    deliveryResult: order.deliveryResult,
    deliveredAt: order.deliveredAt ?? null,
    estimatedDeliveryAt: order.estimatedDeliveryAt ?? null,
    daysSinceDelivery: elapsed,
    refundWindowDays: order.refundWindowDays,
    withinRefundWindow: inWindow,
    alreadyRefunded: order.alreadyRefunded,
    refundId: order.refundId ?? null,
    refundReason: order.refundReason ?? null,
    hasEscalation: order.hasEscalation,
    escalationId: order.escalationId ?? null,
    escalationReason: order.escalationReason ?? null,
    requiresManualInvestigation: order.deliveryResult === 'missing',
    autoRefundableIssue: isAutoRefundableIssue(order),
    referenceNow: REFERENCE_NOW
  };
}

export const listOrdersInputSchema = {} as const;

export function listOrders(store: SupportStore): ToolOutcome {
  const orders = store.listOrders().map(order => ({
    orderId: order.orderId,
    customer: order.customer,
    product: order.productOrdered,
    status: order.status,
    deliveryResult: order.deliveryResult,
    refundStatus: order.alreadyRefunded ? `refunded (${order.refundId})` : 'not refunded',
    escalationStatus: order.hasEscalation ? `escalated (${order.escalationId})` : 'no escalation'
  }));
  return ok(
    `${orders.length} demo orders. This tool is a demo convenience only; it is not part of the refund workflow.`,
    { referenceNow: REFERENCE_NOW, orders }
  );
}

export const getOrderInputSchema = {
  orderId: z.string().min(1).describe('The order identifier, e.g. "order_1042".')
} as const;

export function getOrder(store: SupportStore, args: { orderId: string }): ToolOutcome {
  const order = store.getOrder(args.orderId);
  if (!order) {
    return fail('order_not_found', `Order ${args.orderId} was not found.`, { orderId: args.orderId });
  }
  return ok(`Current state of ${order.orderId}.`, { order: describeOrder(order) });
}

export const createRefundInputSchema = {
  orderId: z.string().min(1).describe('The order to refund.'),
  reason: z.string().min(1).describe('Why the refund is being issued. Must not be empty.')
} as const;

export function createRefund(store: SupportStore, args: { orderId: string; reason: string }): ToolOutcome {
  const reason = args.reason.trim();
  if (reason.length === 0) {
    return fail('empty_reason', 'A non-empty refund reason is required.');
  }

  const order = store.getOrder(args.orderId);
  if (!order) {
    return fail('order_not_found', `Order ${args.orderId} was not found.`, { orderId: args.orderId });
  }
  if (order.alreadyRefunded) {
    return fail(
      'already_refunded',
      `Order ${order.orderId} was already refunded as ${order.refundId}. An order can only be refunded once.`,
      { order: describeOrder(order) }
    );
  }
  if (order.status === 'in_transit') {
    return fail(
      'still_in_transit',
      `Order ${order.orderId} is still in transit (estimated delivery ${order.estimatedDeliveryAt}). In-transit orders are not automatically refundable.`,
      { order: describeOrder(order) }
    );
  }
  if (order.deliveryResult === 'missing') {
    return fail(
      'requires_manual_investigation',
      `Order ${order.orderId} is marked delivered but reported missing. This requires manual investigation via escalate_case, not an automatic refund.`,
      { order: describeOrder(order) }
    );
  }
  if (!isAutoRefundableIssue(order)) {
    return fail(
      'no_eligible_issue',
      `Order ${order.orderId} was delivered correctly and has no recorded refundable issue.`,
      { order: describeOrder(order) }
    );
  }
  if (!withinRefundWindow(order)) {
    return fail(
      'outside_refund_window',
      `Order ${order.orderId} was delivered ${daysSinceDelivery(order)} days ago, outside the ${order.refundWindowDays}-day refund window. Use escalate_case for manual review.`,
      { order: describeOrder(order) }
    );
  }

  const updated = store.recordRefund(order.orderId, reason);
  return ok(`Refund ${updated.refundId} created for ${updated.orderId}.`, {
    refundId: updated.refundId,
    order: describeOrder(updated)
  });
}

export const escalateCaseInputSchema = {
  orderId: z.string().min(1).describe('The order to escalate.'),
  reason: z.string().min(1).describe('Why manual review is needed. Must not be empty.'),
  conflictsWithRecord: z
    .boolean()
    .default(false)
    .describe(
      'Set to true only when the user reports facts that contradict the stored order record. Required to escalate an order whose record shows no problem.'
    )
} as const;

export function escalateCase(
  store: SupportStore,
  args: { orderId: string; reason: string; conflictsWithRecord?: boolean }
): ToolOutcome {
  const reason = args.reason.trim();
  const conflictsWithRecord = args.conflictsWithRecord === true;

  if (reason.length === 0) {
    return fail('empty_reason', 'A non-empty escalation reason is required.');
  }

  const order = store.getOrder(args.orderId);
  if (!order) {
    return fail('order_not_found', `Order ${args.orderId} was not found.`, { orderId: args.orderId });
  }

  if (order.hasEscalation && order.escalationId) {
    const existing = store.getEscalation(order.escalationId);
    return ok(
      `Order ${order.orderId} already has escalation ${order.escalationId}. No duplicate was created.`,
      { escalationId: order.escalationId, escalation: existing ?? null, duplicate: true, order: describeOrder(order) }
    );
  }

  const recordShowsNoProblem = order.status === 'in_transit' || order.deliveryResult === 'correct';
  if (recordShowsNoProblem && !conflictsWithRecord) {
    return fail(
      'record_shows_no_problem',
      `The record for ${order.orderId} shows no problem (${order.status}, delivery result "${order.deliveryResult}"). Set conflictsWithRecord to true only if the user reported facts that contradict the record.`,
      { order: describeOrder(order) }
    );
  }

  const escalation = store.recordEscalation(order.orderId, reason, conflictsWithRecord);
  const updated = store.getOrder(order.orderId)!;
  return ok(`Escalation ${escalation.escalationId} created for ${order.orderId}.`, {
    escalationId: escalation.escalationId,
    escalation,
    duplicate: false,
    order: describeOrder(updated)
  });
}
