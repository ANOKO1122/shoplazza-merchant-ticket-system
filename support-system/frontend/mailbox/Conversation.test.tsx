import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationPane } from './Conversation';

const conversation: any = {
  id: 1, version: 2, subject: 'Claim update', customer_email: 'buyer@example.invalid', status: 'open',
  unread_count: 1, assignee_id: null, claim_id: 22, claim_no: 'CL-random', protection_order_id: 33,
  notification: { subject: 'Claim update', body_text: 'Please send photos', sent_at: '2026-11-13T10:00:00Z' },
  candidate_notification: null, candidates: [],
  messages: [{ id: 5, direction: 'incoming', sender_email: 'buyer@example.invalid', recipient_email: 'customersupport@reply.us-seel.com',
    body_text: '<script>alert(1)</script>', sent_at: '2026-11-13T10:02:00Z', status: 'received', attachments: [] }],
  notes: [{ id: 1, body_text: 'Check tracking first', agent_name: 'Alice', created_at: '2026-11-13T10:03:00Z' }],
};

test('conversation shows original notice, escapes incoming content, and separates private notes from reply', () => {
  const html = renderToStaticMarkup(<ConversationPane conversation={conversation} agents={[]} busy={false} mailboxReady={true} error="" onRefresh={() => {}} onUpdate={async () => {}} onNote={async () => {}} onReply={async () => {}} onLink={async () => {}} />);
  assert.ok(html.includes('Please send photos'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('内部备注'));
  assert.ok(html.includes('发送回复'));
  assert.ok(html.includes('buyer@example.invalid'));
  assert.ok(html.includes('CL-random'));
});

test('forwarded notification is a manual candidate and its original recipient is visible', () => {
  const html = renderToStaticMarkup(<ConversationPane conversation={{ ...conversation, claim_id: null, claim_no: null,
    candidate_notification: { claim_id: 22, claim_no: 'CL-random', recipient_email: 'buyer@example.invalid', subject: 'Claim update' },
    messages: [{ ...conversation.messages[0], sender_email: 'friend@example.invalid' }] }} agents={[]} busy={false} mailboxReady={true} error="" onRefresh={() => {}} onUpdate={async () => {}} onNote={async () => {}} onReply={async () => {}} onLink={async () => {}} />);
  assert.ok(html.includes('待人工核对'));
  assert.ok(html.includes('friend@example.invalid'));
  assert.ok(html.includes('buyer@example.invalid'));
});

test('disconnected mailbox keeps the recipient visible and disables sending', () => {
  const html = renderToStaticMarkup(<ConversationPane conversation={conversation} agents={[]} busy={false} mailboxReady={false} error="" onRefresh={() => {}} onUpdate={async () => {}} onNote={async () => {}} onReply={async () => {}} onLink={async () => {}} />);
  assert.ok(html.includes('buyer@example.invalid'));
  assert.ok(html.includes('邮箱尚未连接，暂时无法发送回复。'));
  assert.match(html, /<button[^>]+type="submit"[^>]+disabled=""/);
});
