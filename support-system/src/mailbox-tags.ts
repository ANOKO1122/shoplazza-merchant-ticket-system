import { getClient, query } from './pg';

const colors = ['blue', 'green', 'amber', 'red', 'purple', 'slate'];
export async function listTags() {
  return (await query('SELECT id,name,color FROM support_mailbox_tags ORDER BY name,id')).rows;
}
export async function createTag(name: unknown, color: unknown, agentId: number) {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!clean || clean.length > 30 || /[\u0000-\u001f\u007f]/.test(clean) || !colors.includes(String(color))) throw new Error('invalid_tag');
  return (await query(`INSERT INTO support_mailbox_tags(name,color,created_by) VALUES($1,$2,$3)
    ON CONFLICT (lower(name)) DO UPDATE SET name=support_mailbox_tags.name RETURNING id,name,color`, [clean, color, agentId])).rows[0];
}
export async function getCustomerTags(conversationId: number) {
  const row = (await query(`SELECT lower(c.customer_email) AS email,COALESCE(cu.tag_version,1) AS version,
    COALESCE((SELECT jsonb_agg(ct.tag_id ORDER BY ct.tag_id) FROM support_mailbox_customer_tags ct
      WHERE ct.customer_email=lower(c.customer_email)), '[]'::jsonb) AS tag_ids
    FROM support_mailbox_conversations c LEFT JOIN support_mailbox_customers cu ON cu.email=lower(c.customer_email)
    WHERE c.id=$1`, [conversationId])).rows[0];
  if (!row) throw new Error('conversation_not_found');
  return row;
}
export async function saveCustomerTags(conversationId: number, version: number, tagIds: unknown, agentId: number) {
  if (!Number.isSafeInteger(version) || version < 1 || !Array.isArray(tagIds) || tagIds.length > 50
    || tagIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('invalid_tags');
  const ids = [...new Set(tagIds)];
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const conversation = (await client.query('SELECT lower(customer_email) AS email FROM support_mailbox_conversations WHERE id=$1', [conversationId])).rows[0];
    if (!conversation) throw new Error('conversation_not_found');
    const email = conversation.email;
    await client.query('INSERT INTO support_mailbox_customers(email) VALUES($1) ON CONFLICT DO NOTHING', [email]);
    const customer = (await client.query('SELECT tag_version FROM support_mailbox_customers WHERE email=$1 FOR UPDATE', [email])).rows[0];
    if (customer.tag_version !== version) throw new Error('stale_version');
    const valid = (await client.query('SELECT id FROM support_mailbox_tags WHERE id=ANY($1::int[])', [ids])).rows;
    if (valid.length !== ids.length) throw new Error('invalid_tags');
    await client.query('DELETE FROM support_mailbox_customer_tags WHERE customer_email=$1', [email]);
    await client.query('INSERT INTO support_mailbox_customer_tags(customer_email,tag_id) SELECT $1,unnest($2::int[])', [email, ids]);
    await client.query('UPDATE support_mailbox_customers SET tag_version=tag_version+1,updated_by=$2,updated_at=now() WHERE email=$1', [email, agentId]);
    await client.query('UPDATE support_mailbox_conversations SET version=version+1,updated_at=now() WHERE lower(customer_email)=$1', [email]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return getCustomerTags(conversationId);
}
