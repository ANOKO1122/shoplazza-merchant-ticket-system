export const EMAIL_PREFERENCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_email_preferences (
  category TEXT NOT NULL CHECK (category IN ('ticket','protection')),
  email TEXT NOT NULL CHECK (email = lower(btrim(email))),
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(category,email)
);
CREATE TABLE IF NOT EXISTS support_email_unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('ticket','protection')),
  email TEXT NOT NULL CHECK (email = lower(btrim(email))),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_email_unsubscribe_recipient ON support_email_unsubscribe_tokens(category,email);
`;
