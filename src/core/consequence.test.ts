import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalQueue } from './approval';
import {
  consequenceOf,
  grantCandidate,
  isGrantable,
  ruleParts,
  StandingRules,
} from './consequence';
import { open } from './db';
import type { Consequence, DraftVariant, PublisherProvider } from '../contracts';

function publisher(over: Partial<PublisherProvider> = {}): PublisherProvider {
  return {
    info: { id: 'test', slot: 'publisher', name: 'test' },
    platform: 'test',
    transport: 'api',
    limits: { maxTextLength: 1000, supportsScheduling: false },
    checkAuth: async () => ({ ok: true }),
    validate: async () => ({ ok: true, errors: [], warnings: [] }),
    publish: async () => ({ platformPostId: 'x', publishedAt: new Date() }),
    ...over,
  } as PublisherProvider;
}

const variant = { id: 'v1', platform: 'test', body: 'hi', media: [] } as DraftVariant;

test('a provider that declares no consequence is treated as irreversible', () => {
  assert.equal(consequenceOf(publisher()), 'irreversible');
  assert.equal(isGrantable('irreversible'), false);
  for (const c of ['local', 'reversible', 'draft_only'] as Consequence[]) {
    assert.equal(isGrantable(c), true, `${c} should be grantable`);
  }
});

test('grantCandidate refuses irreversible actions, missing targets and blank targets', () => {
  assert.equal(
    grantCandidate({ action: 'publish:xhs', target: 'account-1', consequence: 'irreversible' }),
    null,
  );
  assert.equal(grantCandidate(undefined), null);
  assert.equal(
    grantCandidate({ action: 'publish:blog', target: '   ', consequence: 'reversible' }),
    null,
  );
  assert.equal(
    grantCandidate({ action: 'publish:blog', target: '/repo#dir', consequence: 'reversible' }),
    'publish:blog /repo#dir',
  );
});

test('rule entries survive a target containing spaces', () => {
  const entry = grantCandidate({
    action: 'publish:blog',
    target: '/Users/me/My Blog#src/content',
    consequence: 'reversible',
  })!;
  assert.deepEqual(ruleParts(entry), {
    action: 'publish:blog',
    target: '/Users/me/My Blog#src/content',
  });
});

test('the store refuses to record a rule for an irreversible action', () => {
  const rules = new StandingRules(open(':memory:'));
  assert.throws(
    () => rules.grant({ action: 'publish:xhs', target: 'acct', consequence: 'irreversible' }),
    /cannot be pre-approved/,
  );
  assert.equal(rules.list().length, 0);
});

test('a standing rule auto-approves only its exact target', () => {
  const db = open(':memory:');
  const queue = new ApprovalQueue(db);
  queue.standingRules.grant({
    action: 'publish:blog',
    target: '/repo#src/content/blog',
    consequence: 'reversible',
  });

  const covered = queue.enqueue({
    kind: 'publish',
    refId: 'v1',
    payload: variant,
    grant: { action: 'publish:blog', target: '/repo#src/content/blog', consequence: 'reversible' },
  });
  assert.equal(covered.state, 'approved');
  assert.equal(covered.decidedBy, 'rule:publish:blog /repo#src/content/blog');
  assert.match(covered.reason ?? '', /standing rule/);

  // Same action, a different repository — the rule must not carry over.
  const other = queue.enqueue({
    kind: 'publish',
    refId: 'v2',
    payload: variant,
    grant: { action: 'publish:blog', target: '/other-repo#src/content/blog', consequence: 'reversible' },
  });
  assert.equal(other.state, 'pending');
});

test('an irreversible action is never auto-approved, even with a matching entry', () => {
  const db = open(':memory:');
  const queue = new ApprovalQueue(db);
  // Force the row in directly — the store would refuse, so this is the
  // "someone edited the database" case the gate still has to survive.
  db.prepare(
    `INSERT INTO standing_rules (entry, action, target, consequence, created_by, created_at)
     VALUES ('publish:xhs acct-1', 'publish:xhs', 'acct-1', 'irreversible', 'hand-edit', 0)`,
  ).run();

  const appr = queue.enqueue({
    kind: 'publish',
    refId: 'v1',
    payload: variant,
    grant: { action: 'publish:xhs', target: 'acct-1', consequence: 'irreversible' },
  });

  assert.equal(appr.state, 'pending', 'an irreversible publish must still face a human');
  assert.equal(appr.grantEntry, null, 'it must not even advertise the grant');
});

test('revoking restores the human gate immediately', () => {
  const db = open(':memory:');
  const queue = new ApprovalQueue(db);
  const ctx = { action: 'publish:blog', target: '/repo#dir', consequence: 'reversible' as const };
  queue.standingRules.grant(ctx);

  assert.equal(queue.enqueue({ kind: 'publish', refId: 'a', payload: variant, grant: ctx }).state, 'approved');
  assert.equal(queue.standingRules.revoke('publish:blog /repo#dir'), true);
  assert.equal(queue.enqueue({ kind: 'publish', refId: 'b', payload: variant, grant: ctx }).state, 'pending');
  assert.equal(queue.standingRules.revoke('publish:blog /repo#dir'), false, 'revoking twice is not a success');
});

test('granting twice is idempotent', () => {
  const rules = new StandingRules(open(':memory:'));
  const ctx = { action: 'publish:blog', target: '/repo#dir', consequence: 'reversible' as const };
  rules.grant(ctx);
  rules.grant(ctx, 'someone-else');
  assert.equal(rules.list().length, 1);
  assert.equal(rules.list()[0]!.createdBy, 'local', 'the original grant is not silently reattributed');
});

test('an auto-approved item still leaves a full approval row', () => {
  const db = open(':memory:');
  const queue = new ApprovalQueue(db);
  const ctx = { action: 'publish:blog', target: '/repo#dir', consequence: 'reversible' as const };
  queue.standingRules.grant(ctx);
  const appr = queue.enqueue({ kind: 'publish', refId: 'a', payload: variant, grant: ctx });

  const row = queue.get(appr.id)!;
  assert.equal(row.state, 'approved');
  assert.equal(row.grantEntry, 'publish:blog /repo#dir');
  assert.ok(row.payloadHash, 'the payload is still snapshotted and hashed');
  // The integrity check must behave identically for rule-approved items.
  assert.doesNotThrow(() => queue.verifyForExecution(appr.id));
  db.prepare(`UPDATE approvals SET payload = ? WHERE id = ?`).run('{"tampered":true}', appr.id);
  assert.throws(() => queue.verifyForExecution(appr.id), /payload changed/);
});
