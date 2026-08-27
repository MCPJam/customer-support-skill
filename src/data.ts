/**
 * In-memory demo data.
 *
 * Every date in this file is derived from REFERENCE_NOW. Nothing in the server
 * or the tests may call Date.now() or new Date() without arguments, so results
 * are identical whenever the demo is run.
 */

export const REFERENCE_NOW = '2026-06-01T12:00:00.000Z';

export const REFERENCE_NOW_MS = Date.parse(REFERENCE_NOW);

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(days: number): string {
  return new Date(REFERENCE_NOW_MS - days * DAY_MS).toISOString();
}

function daysAfter(days: number): string {
  return new Date(REFERENCE_NOW_MS + days * DAY_MS).toISOString();
}

export type OrderStatus = 'delivered' | 'in_transit';

/** What the record says happened on delivery. `not_applicable` for undelivered orders. */
export type DeliveryResult = 'damaged' | 'wrong_item' | 'missing' | 'correct' | 'not_applicable';

export interface Order {
  orderId: string;
  customer: string;
  productOrdered: string;
  /** Set only when it differs from what was ordered. */
  productReceived?: string;
  status: OrderStatus;
  deliveryResult: DeliveryResult;
  /** ISO date, present only for delivered orders. */
  deliveredAt?: string;
  /** ISO date, present only for in-transit orders. */
  estimatedDeliveryAt?: string;
  refundWindowDays: number;
  alreadyRefunded: boolean;
  refundId?: string;
  refundReason?: string;
  hasEscalation: boolean;
  escalationId?: string;
  escalationReason?: string;
}

export interface Escalation {
  escalationId: string;
  orderId: string;
  reason: string;
  conflictsWithRecord: boolean;
  createdAt: string;
}

function seedOrders(): Order[] {
  return [
    {
      orderId: 'order_1042',
      customer: 'Alex Johnson',
      productOrdered: 'Wireless Headphones',
      status: 'delivered',
      deliveryResult: 'damaged',
      deliveredAt: daysBefore(5),
      refundWindowDays: 30,
      alreadyRefunded: false,
      hasEscalation: false
    },
    {
      orderId: 'order_2048',
      customer: 'Sam Rivera',
      productOrdered: 'Mechanical Keyboard',
      status: 'delivered',
      deliveryResult: 'damaged',
      deliveredAt: daysBefore(45),
      refundWindowDays: 30,
      alreadyRefunded: false,
      hasEscalation: false
    },
    {
      orderId: 'order_3091',
      customer: 'Taylor Kim',
      productOrdered: 'USB-C Dock',
      status: 'delivered',
      deliveryResult: 'damaged',
      deliveredAt: daysBefore(7),
      refundWindowDays: 30,
      alreadyRefunded: true,
      refundId: 'refund_3091',
      refundReason: 'Item arrived damaged',
      hasEscalation: false
    },
    {
      orderId: 'order_4177',
      customer: 'Jordan Smith',
      productOrdered: 'Smartwatch',
      status: 'delivered',
      deliveryResult: 'missing',
      deliveredAt: daysBefore(2),
      refundWindowDays: 30,
      alreadyRefunded: false,
      hasEscalation: false
    },
    {
      orderId: 'order_5230',
      customer: 'Casey Brown',
      productOrdered: 'Laptop Stand',
      productReceived: 'Tablet Stand',
      status: 'delivered',
      deliveryResult: 'wrong_item',
      deliveredAt: daysBefore(3),
      refundWindowDays: 30,
      alreadyRefunded: false,
      hasEscalation: false
    },
    {
      orderId: 'order_6104',
      customer: 'Morgan Lee',
      productOrdered: 'Webcam',
      status: 'delivered',
      deliveryResult: 'correct',
      deliveredAt: daysBefore(6),
      refundWindowDays: 30,
      alreadyRefunded: false,
      hasEscalation: false
    },
    {
      orderId: 'order_7285',
      customer: 'Jamie Wilson',
      productOrdered: 'External SSD',
      status: 'delivered',
      deliveryResult: 'correct',
      deliveredAt: daysBefore(35),
      refundWindowDays: 30,
      alreadyRefunded: false,
      hasEscalation: false
    },
    {
      orderId: 'order_8362',
      customer: 'Riley Davis',
      productOrdered: 'Gaming Mouse',
      status: 'in_transit',
      deliveryResult: 'not_applicable',
      estimatedDeliveryAt: daysAfter(3),
      refundWindowDays: 30,
      alreadyRefunded: false,
      hasEscalation: false
    }
  ];
}

/** Mutable per-process demo state. */
export class SupportStore {
  private orders = new Map<string, Order>();
  private escalations = new Map<string, Escalation>();
  private refundCounter = 0;
  private escalationCounter = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.orders = new Map(seedOrders().map(order => [order.orderId, order]));
    this.escalations = new Map();
    this.refundCounter = 0;
    this.escalationCounter = 0;
  }

  listOrders(): Order[] {
    return [...this.orders.values()].map(order => ({ ...order }));
  }

  getOrder(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    return order ? { ...order } : undefined;
  }

  getEscalation(escalationId: string): Escalation | undefined {
    const escalation = this.escalations.get(escalationId);
    return escalation ? { ...escalation } : undefined;
  }

  recordRefund(orderId: string, reason: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    this.refundCounter += 1;
    order.alreadyRefunded = true;
    order.refundId = `refund_${orderId.replace(/^order_/, '')}_${this.refundCounter}`;
    order.refundReason = reason;
    return { ...order };
  }

  recordEscalation(orderId: string, reason: string, conflictsWithRecord: boolean): Escalation {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    this.escalationCounter += 1;
    const escalation: Escalation = {
      escalationId: `esc_${orderId.replace(/^order_/, '')}_${this.escalationCounter}`,
      orderId,
      reason,
      conflictsWithRecord,
      createdAt: REFERENCE_NOW
    };
    this.escalations.set(escalation.escalationId, escalation);
    order.hasEscalation = true;
    order.escalationId = escalation.escalationId;
    order.escalationReason = reason;
    return { ...escalation };
  }
}

/** Days elapsed between delivery and REFERENCE_NOW. */
export function daysSinceDelivery(order: Order): number | null {
  if (!order.deliveredAt) return null;
  return Math.floor((REFERENCE_NOW_MS - Date.parse(order.deliveredAt)) / DAY_MS);
}

export function withinRefundWindow(order: Order): boolean {
  const elapsed = daysSinceDelivery(order);
  if (elapsed === null) return false;
  return elapsed <= order.refundWindowDays;
}

/** Issues the policy allows to be refunded automatically (inside the window). */
export function isAutoRefundableIssue(order: Order): boolean {
  return order.deliveryResult === 'damaged' || order.deliveryResult === 'wrong_item';
}
