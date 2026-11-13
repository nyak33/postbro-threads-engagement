-- PB-P0-003 slice C: durable single-use nonces for signed operator link tokens.
-- The JTI of each minted link token is recorded once and consumed atomically
-- on first use, so replay of the same signed link is denied even under
-- concurrent requests. Link tokens only bootstrap a Threads OAuth connect
-- attempt for an already-authenticated operator; they grant no data access.

CREATE TABLE postbro.link_token_nonces (
  jti text PRIMARY KEY,
  operator_id bigint NOT NULL REFERENCES postbro.operators(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose = 'threads_connect'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(jti) BETWEEN 16 AND 64),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX link_token_nonces_operator_expiry ON postbro.link_token_nonces (operator_id, expires_at);

ALTER TABLE postbro.link_token_nonces ENABLE ROW LEVEL SECURITY;

CREATE POLICY postbro_app_link_token_nonces_operator_scope ON postbro.link_token_nonces
  FOR ALL TO postbro_app
  USING (operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint)
  WITH CHECK (operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint);
