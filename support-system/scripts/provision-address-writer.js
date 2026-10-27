// Run as the database owner after the address schema migration. No credentials
// are printed; the new login is delivered through a private file outside Git.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

async function main() {
  const credentialFile = process.env.ADDRESS_WRITER_CREDENTIAL_FILE;
  const publicHost = process.env.ADDRESS_WRITER_PUBLIC_HOST;
  if (!credentialFile || !path.isAbsolute(credentialFile) || !publicHost) {
    throw new Error('Set ADDRESS_WRITER_CREDENTIAL_FILE (absolute path) and ADDRESS_WRITER_PUBLIC_HOST');
  }
  const ownerUrl = new URL(process.env.SUPPORT_DATABASE_URL);
  if (process.env.ADDRESS_WRITER_DATABASE_HOST) ownerUrl.hostname = process.env.ADDRESS_WRITER_DATABASE_HOST;
  const pool = new Pool({ connectionString: ownerUrl.toString(), max: 1 });
  const role = 'order_address_writer';
  let credentials;
  if (fs.existsSync(credentialFile)) {
    credentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    if (credentials.user !== role || !credentials.password) throw new Error('Unexpected credential file');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS privileged
      FROM pg_roles r WHERE r.rolname=$1`, [role]);
    if (existing.rowCount && !credentials) throw new Error('Role already exists; supply its existing private credential file');
    if (existing.rows[0]?.privileged) throw new Error('Existing role has elevated privileges or memberships; refusing to reuse it');
    const password = credentials?.password || crypto.randomBytes(32).toString('base64url');
    if (!existing.rowCount) {
      const generated = await client.query(
        "SELECT format('CREATE ROLE order_address_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 8 PASSWORD %L', $1::text) AS ddl",
        [password],
      );
      await client.query(generated.rows[0].ddl);
    }
    const database = decodeURIComponent(ownerUrl.pathname.slice(1));
    const publicUrl = new URL(`postgresql://${publicHost}:${ownerUrl.port || '5432'}/${encodeURIComponent(database)}`);
    publicUrl.username = role;
    publicUrl.password = password;
    publicUrl.searchParams.set('sslmode', 'require');
    publicUrl.searchParams.set('application_name', 'maildesk-order-address-writer');
    // node-postgres distinguishes no-verify from require in newer releases.
    // Keep the standard libpq URI separate from the pg-specific TLS URI.
    const nodeUrl = new URL(publicUrl);
    nodeUrl.searchParams.set('sslmode', 'no-verify');
    credentials = { host: publicHost, port: Number(ownerUrl.port || 5432), database,
      user: role, password, sslmode: 'require', connectionString: publicUrl.toString(),
      nodeConnectionString: nodeUrl.toString() };
    const grantDb = await client.query("SELECT format('GRANT CONNECT ON DATABASE %I TO order_address_writer', current_database()) AS ddl");
    await client.query(grantDb.rows[0].ddl);
    await client.query(`
      ALTER ROLE order_address_writer SET statement_timeout = '15s';
      ALTER ROLE order_address_writer SET idle_in_transaction_session_timeout = '15s';
      ALTER ROLE order_address_writer SET search_path = public;
      GRANT USAGE ON SCHEMA public TO order_address_writer;
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM order_address_writer;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM order_address_writer;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM order_address_writer;
      GRANT SELECT ON public.support_order_snapshots, public.support_shipping_address_requests TO order_address_writer;
      GRANT EXECUTE ON FUNCTION public.support_submit_shipping_address_change(TEXT,TEXT,JSONB,JSONB,TEXT,TEXT) TO order_address_writer;
    `);
    fs.mkdirSync(path.dirname(credentialFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentialFile, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(credentialFile, 0o600);
    await client.query('COMMIT');
    console.log('order_address_writer provisioned; private credentials saved (not printed).');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
