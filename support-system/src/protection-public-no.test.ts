import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PROTECTION_PUBLIC_NO_MIGRATION_SQL } from './protection-schema';

const databaseUrl = process.env.SUPPORT_PROTECTION_TEST_DATABASE_URL;

test('legacy protection and claim references survive the random-reference migration', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/, 'Requires an isolated test database');
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE support_protection_orders (
        id BIGSERIAL PRIMARY KEY,
        public_no TEXT GENERATED ALWAYS AS ('SP-' || lpad(id::text, 10, '0')) STORED UNIQUE
      );
      CREATE TEMP TABLE support_protection_claims (
        id BIGSERIAL PRIMARY KEY,
        public_no TEXT GENERATED ALWAYS AS ('CL-' || lpad(id::text, 10, '0')) STORED UNIQUE
      );
      INSERT INTO support_protection_orders DEFAULT VALUES;
      INSERT INTO support_protection_claims DEFAULT VALUES;
    `);

    await client.query(PROTECTION_PUBLIC_NO_MIGRATION_SQL);
    await client.query(PROTECTION_PUBLIC_NO_MIGRATION_SQL);
    const oldOrder = (await client.query('SELECT public_no FROM support_protection_orders WHERE id=1')).rows[0].public_no;
    const oldClaim = (await client.query('SELECT public_no FROM support_protection_claims WHERE id=1')).rows[0].public_no;
    assert.equal(oldOrder, 'SP-0000000001');
    assert.equal(oldClaim, 'CL-0000000001');

    await client.query('INSERT INTO support_protection_orders DEFAULT VALUES');
    await client.query('INSERT INTO support_protection_orders DEFAULT VALUES');
    await client.query('INSERT INTO support_protection_claims DEFAULT VALUES');
    await client.query('INSERT INTO support_protection_claims DEFAULT VALUES');
    const orders = (await client.query('SELECT id,public_no FROM support_protection_orders WHERE id>1 ORDER BY id')).rows;
    const claims = (await client.query('SELECT id,public_no FROM support_protection_claims WHERE id>1 ORDER BY id')).rows;
    for (const [rows, prefix] of [[orders, 'SP'], [claims, 'CL']] as const) {
      assert.equal(rows.length, 2);
      assert.match(rows[0].public_no, new RegExp(`^${prefix}-[0-9A-F]{20}$`));
      assert.match(rows[1].public_no, new RegExp(`^${prefix}-[0-9A-F]{20}$`));
      assert.notEqual(rows[0].public_no, rows[1].public_no);
      assert.notEqual(rows[0].public_no, `${prefix}-000000000${rows[0].id}`);
    }

    await assert.rejects(client.query('INSERT INTO support_protection_orders(public_no) VALUES($1)', [orders[0].public_no]), (error: any) => error.code === '23505');
    await assert.rejects(client.query('INSERT INTO support_protection_claims(public_no) VALUES($1)', [claims[0].public_no]), (error: any) => error.code === '23505');
  } finally {
    client.release();
    await pool.end();
  }
});
