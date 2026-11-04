import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

async function runScript(name: string, databaseUrl?: string) {
  const connections: unknown[] = [], errors: string[] = [];
  let exitCode = 0;
  class Pool {
    constructor(options: unknown) { connections.push(options); }
    async query() { return { rowCount: 1, rows: [] }; }
    async end() {}
  }
  const process = { env: { SUPPORT_DATABASE_URL: databaseUrl }, get exitCode() { return exitCode; }, set exitCode(code: number) { exitCode = code; }, exit(code: number) { exitCode = code; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts', name), 'utf8'), {
    require: (id: string) => { assert.equal(id, 'pg'); return { Pool }; },
    process, console: { log() {}, error(message: string) { errors.push(message); } },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { connections, errors, exitCode };
}

for (const name of ['check-webhook-results.js', 'create-db.js', 'verify-tables.js']) {
  test(`${name} requires explicit database configuration before creating a connection`, async () => {
    for (const value of [undefined, '  ']) {
      const result = await runScript(name, value);
      assert.deepEqual(result.connections, []);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.errors.join('\n'), /SUPPORT_DATABASE_URL/);
    }
    const configured = await runScript(name, 'postgresql://fixture@database.invalid/maintenance_test');
    assert.equal(configured.exitCode, 0);
    assert.equal((configured.connections[0] as { connectionString: string }).connectionString, 'postgresql://fixture@database.invalid/maintenance_test');
  });
}
