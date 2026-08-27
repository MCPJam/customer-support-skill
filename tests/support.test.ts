import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SupportStore, REFERENCE_NOW } from '../src/data.js';
import { createRefund, escalateCase, getOrder, listOrders } from '../src/tools.js';
import { SkillRegistry, parseFrontmatter, InvalidSkillParams } from '../src/skills.js';

let store: SupportStore;

beforeEach(() => {
  store = new SupportStore();
});

const orderOf = (outcome: { data: Record<string, unknown> }) =>
  outcome.data['order'] as Record<string, unknown>;

describe('list_orders', () => {
  test('returns all eight demo orders', () => {
    const result = listOrders(store);
    assert.equal(result.isError, false);
    const orders = result.data['orders'] as unknown[];
    assert.equal(orders.length, 8);
    assert.deepEqual(
      (orders as Array<{ orderId: string }>).map(o => o.orderId),
      [
        'order_1042',
        'order_2048',
        'order_3091',
        'order_4177',
        'order_5230',
        'order_6104',
        'order_7285',
        'order_8362'
      ]
    );
  });
});

describe('get_order', () => {
  test('returns the correct state for an eligible damaged order', () => {
    const result = getOrder(store, { orderId: 'order_1042' });
    assert.equal(result.isError, false);
    const order = orderOf(result);
    assert.equal(order['customer'], 'Alex Johnson');
    assert.equal(order['deliveryResult'], 'damaged');
    assert.equal(order['daysSinceDelivery'], 5);
    assert.equal(order['withinRefundWindow'], true);
    assert.equal(order['alreadyRefunded'], false);
    assert.equal(order['hasEscalation'], false);
  });

  test('reports the already-refunded order with its refund id', () => {
    const order = orderOf(getOrder(store, { orderId: 'order_3091' }));
    assert.equal(order['alreadyRefunded'], true);
    assert.equal(order['refundId'], 'refund_3091');
  });

  test('reports the in-transit order with an estimated delivery date', () => {
    const order = orderOf(getOrder(store, { orderId: 'order_8362' }));
    assert.equal(order['status'], 'in_transit');
    assert.equal(order['deliveredAt'], null);
    assert.equal(order['withinRefundWindow'], false);
    assert.ok(typeof order['estimatedDeliveryAt'] === 'string');
  });

  test('reports the wrong-item order with both products', () => {
    const order = orderOf(getOrder(store, { orderId: 'order_5230' }));
    assert.equal(order['productOrdered'], 'Laptop Stand');
    assert.equal(order['productReceived'], 'Tablet Stand');
    assert.equal(order['receivedDifferentProduct'], true);
  });

  test('unknown orders produce a controlled error, not a throw', () => {
    const result = getOrder(store, { orderId: 'order_9999' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'order_not_found');
  });

  test('does not mutate state', () => {
    getOrder(store, { orderId: 'order_1042' });
    assert.equal(store.getOrder('order_1042')?.alreadyRefunded, false);
  });

  test('eligibility is stable regardless of the real system clock', () => {
    const first = orderOf(getOrder(store, { orderId: 'order_2048' }));
    assert.equal(first['referenceNow'], REFERENCE_NOW);
    assert.equal(first['daysSinceDelivery'], 45);
    assert.equal(first['withinRefundWindow'], false);
    // Same answer for a fresh store built at a different wall-clock moment.
    const second = orderOf(getOrder(new SupportStore(), { orderId: 'order_2048' }));
    assert.deepEqual(second, first);
  });
});

describe('create_refund', () => {
  test('refunds an eligible damaged order and updates state', () => {
    const result = createRefund(store, { orderId: 'order_1042', reason: 'Item arrived damaged' });
    assert.equal(result.isError, false);
    const refundId = result.data['refundId'] as string;
    assert.match(refundId, /^refund_1042_/);
    assert.equal(store.getOrder('order_1042')?.alreadyRefunded, true);
    assert.equal(store.getOrder('order_1042')?.refundId, refundId);
  });

  test('refunds an eligible wrong-item order', () => {
    const result = createRefund(store, { orderId: 'order_5230', reason: 'Received the wrong product' });
    assert.equal(result.isError, false);
  });

  test('rejects an unknown order', () => {
    const result = createRefund(store, { orderId: 'order_9999', reason: 'x' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'order_not_found');
  });

  test('rejects an empty reason', () => {
    const result = createRefund(store, { orderId: 'order_1042', reason: '   ' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'empty_reason');
    assert.equal(store.getOrder('order_1042')?.alreadyRefunded, false);
  });

  test('rejects an order outside the refund window even when called directly', () => {
    const result = createRefund(store, { orderId: 'order_2048', reason: 'Damaged' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'outside_refund_window');
    assert.equal(store.getOrder('order_2048')?.alreadyRefunded, false);
  });

  test('refuses to refund an already-refunded order twice', () => {
    const result = createRefund(store, { orderId: 'order_3091', reason: 'Damaged' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'already_refunded');
    assert.equal(store.getOrder('order_3091')?.refundId, 'refund_3091');
  });

  test('refuses a second refund on an order it just refunded', () => {
    assert.equal(createRefund(store, { orderId: 'order_1042', reason: 'Damaged' }).isError, false);
    const second = createRefund(store, { orderId: 'order_1042', reason: 'Damaged again' });
    assert.equal(second.isError, true);
    assert.equal(second.data['code'], 'already_refunded');
  });

  test('refuses to auto-refund a delivered-but-missing order', () => {
    const result = createRefund(store, { orderId: 'order_4177', reason: 'Never arrived' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'requires_manual_investigation');
  });

  test('refuses to refund a correctly delivered order', () => {
    const result = createRefund(store, { orderId: 'order_6104', reason: 'Changed my mind' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'no_eligible_issue');
  });

  test('refuses to refund an in-transit order', () => {
    const result = createRefund(store, { orderId: 'order_8362', reason: 'Taking too long' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'still_in_transit');
  });
});

describe('escalate_case', () => {
  test('creates an escalation for a damaged order outside the window', () => {
    const result = escalateCase(store, {
      orderId: 'order_2048',
      reason: 'Damaged item outside the refund window'
    });
    assert.equal(result.isError, false);
    const escalationId = result.data['escalationId'] as string;
    assert.match(escalationId, /^esc_2048_/);
    assert.equal(store.getOrder('order_2048')?.hasEscalation, true);
    assert.equal(store.getEscalation(escalationId)?.reason, 'Damaged item outside the refund window');
  });

  test('creates an escalation for a delivered-but-missing order', () => {
    const result = escalateCase(store, { orderId: 'order_4177', reason: 'Marked delivered, never received' });
    assert.equal(result.isError, false);
    assert.equal(result.data['duplicate'], false);
  });

  test('prevents duplicate escalations and returns the existing one', () => {
    const first = escalateCase(store, { orderId: 'order_4177', reason: 'Never received' });
    const second = escalateCase(store, { orderId: 'order_4177', reason: 'Still never received' });
    assert.equal(second.isError, false);
    assert.equal(second.data['duplicate'], true);
    assert.equal(second.data['escalationId'], first.data['escalationId']);
    assert.equal(store.getEscalation(first.data['escalationId'] as string)?.reason, 'Never received');
  });

  test('rejects an unknown order', () => {
    assert.equal(escalateCase(store, { orderId: 'order_9999', reason: 'x' }).data['code'], 'order_not_found');
  });

  test('rejects an empty reason', () => {
    assert.equal(escalateCase(store, { orderId: 'order_2048', reason: '' }).data['code'], 'empty_reason');
  });

  test('rejects escalating a clean delivered order without conflictsWithRecord', () => {
    const result = escalateCase(store, { orderId: 'order_6104', reason: 'User is unhappy' });
    assert.equal(result.isError, true);
    assert.equal(result.data['code'], 'record_shows_no_problem');
    assert.equal(store.getOrder('order_6104')?.hasEscalation, false);
  });

  test('accepts escalating a clean delivered order when conflictsWithRecord is true', () => {
    const result = escalateCase(store, {
      orderId: 'order_6104',
      reason: 'User reports the webcam arrived cracked',
      conflictsWithRecord: true
    });
    assert.equal(result.isError, false);
    assert.equal(store.getOrder('order_6104')?.hasEscalation, true);
  });

  test('rejects escalating an in-transit order without conflictsWithRecord, accepts it with', () => {
    assert.equal(
      escalateCase(store, { orderId: 'order_8362', reason: 'Where is it' }).data['code'],
      'record_shows_no_problem'
    );
    assert.equal(
      escalateCase(store, {
        orderId: 'order_8362',
        reason: 'Carrier says the parcel was returned to sender',
        conflictsWithRecord: true
      }).isError,
      false
    );
  });
});

describe('skill registry', () => {
  const registry = new SkillRegistry();

  test('discovery returns handle-refund-request', () => {
    const page = registry.list(undefined);
    assert.equal(page.skills.length, 1);
    assert.equal(page.nextCursor, undefined);
    const entry = page.skills[0]!;
    assert.equal(entry.uri, 'skill://handle-refund-request/SKILL.md');
    assert.equal(entry.frontmatter['name'], 'handle-refund-request');
    assert.equal(typeof entry.frontmatter['description'], 'string');
  });

  test('pagination returns one skill per page and a usable cursor', () => {
    const first = registry.list(undefined, 1);
    assert.equal(first.skills.length, 1);
    // Only one skill exists, so the first page is already the last.
    assert.equal(first.nextCursor, undefined);
    const past = registry.list(Buffer.from('1').toString('base64url'), 1);
    assert.equal(past.skills.length, 0);
    assert.throws(() => registry.list('not-a-cursor'), InvalidSkillParams);
  });

  test('the resources manifest is complete, with digests and sizes', () => {
    const entry = registry.get('skill://handle-refund-request/SKILL.md');
    const uris = entry.resources.map(r => r.uri).sort();
    assert.deepEqual(uris, [
      'skill://handle-refund-request/SKILL.md',
      'skill://handle-refund-request/refund-policy.md'
    ]);
    for (const resource of entry.resources) {
      assert.match(resource.digest, /^sha256:[0-9a-f]{64}$/);
      assert.ok(resource.size > 0);
    }
    // Limits from the SEP: <= 512 entries and <= 16 MiB total.
    assert.ok(entry.resources.length <= 512);
    assert.ok(entry.resources.reduce((sum, r) => sum + r.size, 0) <= 16 * 1024 * 1024);
  });

  test('skills/get rejects a URI the server does not serve as a skill', () => {
    assert.throws(() => registry.get('skill://handle-refund-request/refund-policy.md'), InvalidSkillParams);
    assert.throws(() => registry.get('skill://nope/SKILL.md'), InvalidSkillParams);
  });

  test('SKILL.md can be read, and its digest matches the manifest', () => {
    const entry = registry.get('skill://handle-refund-request/SKILL.md');
    const file = registry.readFile('skill://handle-refund-request/SKILL.md');
    assert.equal(file.mimeType, 'text/markdown');
    assert.ok(file.bytes.toString('utf8').startsWith('---\n'));
    const declared = entry.resources.find(r => r.uri === file.uri)!;
    assert.equal(declared.size, file.bytes.byteLength);
    assert.equal(declared.digest, file.digest);
  });

  test('refund-policy.md can be read', () => {
    const file = registry.readFile('skill://handle-refund-request/refund-policy.md');
    assert.equal(file.mimeType, 'text/markdown');
    assert.match(file.bytes.toString('utf8'), /Standard refund window|standard refund window/i);
  });

  test('frontmatter matches the parsed SKILL.md, as the SEP requires', () => {
    const entry = registry.get('skill://handle-refund-request/SKILL.md');
    const parsed = parseFrontmatter(registry.readFile(entry.uri).bytes.toString('utf8'));
    assert.deepEqual(parsed.frontmatter, entry.frontmatter);
  });

  test('rejects traversal and undeclared paths', () => {
    const hostile = [
      'skill://handle-refund-request/../../etc/passwd',
      'skill://handle-refund-request/../handle-refund-request/SKILL.md',
      'skill://handle-refund-request/./SKILL.md',
      'skill://handle-refund-request/%2e%2e/SKILL.md',
      'skill://handle-refund-request/SKILL.md/../refund-policy.md',
      'skill://handle-refund-request/not-declared.md',
      'file:///etc/passwd',
      '/etc/passwd',
      'skill://handle-refund-request',
      'skill://handle-refund-request/'
    ];
    for (const uri of hostile) {
      assert.throws(() => registry.readFile(uri), InvalidSkillParams, `expected rejection for ${uri}`);
    }
  });

  test('directory read lists the skill root children only', () => {
    const children = registry.readDirectory('skill://handle-refund-request');
    assert.deepEqual(
      children.map(c => c.name).sort(),
      ['SKILL.md', 'refund-policy.md']
    );
    assert.throws(() => registry.readDirectory('skill://handle-refund-request/SKILL.md'), InvalidSkillParams);
    assert.throws(() => registry.readDirectory('skill://handle-refund-request/../..'), InvalidSkillParams);
  });
});
