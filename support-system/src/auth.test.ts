import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Pool } from 'pg';
import { changeAgentPassword, getRequestAgent, loginAgent, verifySession } from './auth';

function mockQueries(t: TestContext, query: (sql: string, values: unknown[]) => unknown) {
  t.mock.method(Pool.prototype, 'connect', () => { throw new Error('Real database access forbidden'); });
  t.mock.method(Pool.prototype, 'query', async (sql: string, values: unknown[] = []) => query(sql, values));
}

test('authenticated sessions expose the numeric agentId used by password changes and replies', async t => {
  mockQueries(t, (sql, values) => {
    assert.match(sql, /s\.expires_at > now\(\) AND a\.enabled = true/);
    assert.equal(values[0], crypto.createHash('sha256').update('fixture-session').digest('hex'));
    return { rows: [{ id: '42', name: 'Fixture Agent', role: 'admin' }] };
  });
  const agent = await getRequestAgent({ headers: { cookie: 'support_session=fixture-session' } });
  assert.deepEqual(agent, { agentId: 42, name: 'Fixture Agent', role: 'admin' });
});

test('missing or expired sessions do not authenticate', async t => {
  let calls = 0;
  mockQueries(t, () => { calls += 1; return { rows: [] }; });
  assert.equal(await getRequestAgent({ headers: {} }), null);
  assert.equal(calls, 0);
  assert.equal(await verifySession('expired-fixture'), null);
  assert.equal(calls, 1);
});

test('session agentId changes the correct password and revokes only other sessions', async t => {
  const salt = '0123456789abcdef0123456789abcdef';
  const passwordHash = `${salt}:${crypto.scryptSync('old-fixture-password', salt, 64).toString('hex')}`;
  const statements: string[] = [];
  mockQueries(t, (sql, values) => {
    statements.push(sql);
    if (sql.includes('JOIN support_agents')) return { rows: [{ id: '42', name: 'Agent', role: 'admin' }] };
    if (sql.includes('SELECT password_hash')) {
      assert.equal(values[0], 42);
      return { rows: [{ password_hash: passwordHash }] };
    }
    if (sql.includes('UPDATE support_agents')) {
      assert.equal(values[1], 42);
      const [newSalt, hash] = String(values[0]).split(':');
      assert.equal(hash, crypto.scryptSync('new-fixture-password', newSalt, 64).toString('hex'));
      return { rowCount: 1, rows: [] };
    }
    assert.match(sql, /DELETE FROM support_agent_sessions/);
    assert.deepEqual(values, [42, crypto.createHash('sha256').update('current-session').digest('hex')]);
    return { rowCount: 1, rows: [] };
  });
  const agent = await verifySession('current-session');
  assert.ok(agent);
  assert.equal(await changeAgentPassword(agent.agentId, 'old-fixture-password', 'new-fixture-password', 'current-session'), true);
  assert.equal(statements.length, 4);
});

test('invalid login input and malformed password hashes fail without throwing', async t => {
  let calls = 0;
  mockQueries(t, () => {
    calls += 1;
    return { rows: [{ id: 42, enabled: true, password_hash: 'bad:hash' }] };
  });
  assert.equal(await loginAgent({} as string, 'password'), null);
  assert.equal(await loginAgent('agent', [] as unknown as string), null);
  assert.equal(calls, 0);
  assert.equal(await loginAgent('agent', 'password'), null);
  assert.equal(await changeAgentPassword(42, {} as string, 'new-password'), false);
  assert.equal(calls, 2);
});
