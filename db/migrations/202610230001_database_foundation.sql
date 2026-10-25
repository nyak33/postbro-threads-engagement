-- PB-P0-002 database foundation
-- Local disposable PostgreSQL/Supabase-compatible schema. No hosted project is created or modified.

DO $$
BEGIN
  CREATE ROLE postbro_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE postbro_anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE SCHEMA IF NOT EXISTS postbro;

REVOKE ALL ON SCHEMA postbro FROM PUBLIC;
REVOKE ALL ON SCHEMA postbro FROM postbro_anon;

CREATE TABLE postbro.operators (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_user_id bigint NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE postbro.oauth_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_id bigint NOT NULL REFERENCES postbro.operators(id) ON DELETE RESTRICT,
  state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX oauth_sessions_operator_expiry ON postbro.oauth_sessions (operator_id, expires_at);

CREATE TABLE postbro.threads_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL UNIQUE,
  username text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  scopes text[] NOT NULL DEFAULT '{}',
  token_ciphertext bytea,
  token_key_id text,
  token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (token_ciphertext IS NULL OR octet_length(token_ciphertext) > 0)
);

CREATE TABLE postbro.operator_accounts (
  operator_id bigint NOT NULL REFERENCES postbro.operators(id) ON DELETE RESTRICT,
  account_id bigint NOT NULL REFERENCES postbro.threads_accounts(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, account_id)
);

CREATE TABLE postbro.personas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES postbro.threads_accounts(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, name)
);

CREATE TABLE postbro.persona_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL,
  persona_id bigint NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (persona_id, version),
  FOREIGN KEY (account_id, persona_id) REFERENCES postbro.personas(account_id, id) ON DELETE RESTRICT
);

CREATE TABLE postbro.persona_bindings (
  account_id bigint PRIMARY KEY REFERENCES postbro.threads_accounts(id) ON DELETE RESTRICT,
  persona_version_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, persona_version_id) REFERENCES postbro.persona_versions(account_id, id) ON DELETE RESTRICT
);

CREATE TABLE postbro.engagement_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES postbro.threads_accounts(id) ON DELETE RESTRICT,
  provider_reply_id text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, provider_reply_id)
);

CREATE TABLE postbro.engagement_proposals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL,
  event_id bigint NOT NULL,
  proposed_text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, event_id) REFERENCES postbro.engagement_events(account_id, id) ON DELETE RESTRICT
);

CREATE TABLE postbro.engagement_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL,
  proposal_id bigint NOT NULL,
  action_key text NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'processing', 'confirmed', 'failed', 'needs_reconciliation', 'cancelled')),
  claimed_by text,
  lease_token text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, action_key),
  FOREIGN KEY (account_id, proposal_id) REFERENCES postbro.engagement_proposals(account_id, id) ON DELETE RESTRICT,
  CHECK (
    (status IN ('claimed', 'processing') AND claimed_by IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status NOT IN ('claimed', 'processing') AND claimed_by IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX engagement_jobs_claimable ON postbro.engagement_jobs (status, next_attempt_at, id);

CREATE TABLE postbro.approvals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES postbro.threads_accounts(id) ON DELETE RESTRICT,
  operator_id bigint NOT NULL REFERENCES postbro.operators(id) ON DELETE RESTRICT,
  proposal_id bigint NOT NULL,
  action_key text NOT NULL,
  action_type text NOT NULL CHECK (action_type = 'engagement_reply'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (operator_id, account_id) REFERENCES postbro.operator_accounts(operator_id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, proposal_id) REFERENCES postbro.engagement_proposals(account_id, id) ON DELETE RESTRICT,
  CHECK (status = 'pending' OR decided_at IS NOT NULL)
);
CREATE UNIQUE INDEX approvals_one_pending_per_action ON postbro.approvals (account_id, action_key) WHERE status = 'pending';

CREATE TABLE postbro.execution_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES postbro.threads_accounts(id) ON DELETE RESTRICT,
  engagement_job_id bigint NOT NULL,
  action_key text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failed', 'ambiguous', 'needs_reconciliation')),
  provider_request jsonb NOT NULL DEFAULT '{}',
  provider_response jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, action_key, attempt_no),
  FOREIGN KEY (account_id, engagement_job_id) REFERENCES postbro.engagement_jobs(account_id, id) ON DELETE RESTRICT
);

CREATE TABLE postbro.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('operator', 'system')),
  operator_id bigint REFERENCES postbro.operators(id) ON DELETE RESTRICT,
  account_id bigint REFERENCES postbro.threads_accounts(id) ON DELETE RESTRICT,
  action text NOT NULL,
  reason text,
  outcome text NOT NULL,
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (metadata::text !~* '(sb_secret_|github_pat_|ghp_|BEGIN [A-Z ]+PRIVATE KEY|Bearer [A-Za-z0-9._~+/=-]+)'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reason IS NULL OR reason !~* '(sb_secret_|github_pat_|ghp_|BEGIN [A-Z ]+PRIVATE KEY|Bearer [A-Za-z0-9._~+/=-]+)')
);
CREATE INDEX audit_events_account_time ON postbro.audit_events (account_id, created_at);

ALTER TABLE postbro.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.threads_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.operator_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.persona_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.persona_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.engagement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.engagement_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.engagement_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY postbro_app_operator_scope ON postbro.operators
  FOR ALL TO postbro_app
  USING (id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint)
  WITH CHECK (id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint);

CREATE POLICY postbro_app_oauth_operator_scope ON postbro.oauth_sessions
  FOR ALL TO postbro_app
  USING (operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint)
  WITH CHECK (operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint);

CREATE POLICY postbro_app_account_scope ON postbro.threads_accounts
  FOR ALL TO postbro_app
  USING (id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_operator_account_scope ON postbro.operator_accounts
  FOR ALL TO postbro_app
  USING (operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint AND account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint AND account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_personas_account_scope ON postbro.personas
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_persona_versions_account_scope ON postbro.persona_versions
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_persona_bindings_account_scope ON postbro.persona_bindings
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_engagement_events_account_scope ON postbro.engagement_events
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_engagement_proposals_account_scope ON postbro.engagement_proposals
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_engagement_jobs_account_scope ON postbro.engagement_jobs
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_approvals_account_scope ON postbro.approvals
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint AND operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint AND operator_id = NULLIF(current_setting('postbro.operator_id', true), '')::bigint);

CREATE POLICY postbro_app_execution_attempts_account_scope ON postbro.execution_attempts
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

CREATE POLICY postbro_app_audit_events_account_scope ON postbro.audit_events
  FOR ALL TO postbro_app
  USING (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint)
  WITH CHECK (account_id = NULLIF(current_setting('postbro.account_id', true), '')::bigint);

REVOKE ALL ON ALL TABLES IN SCHEMA postbro FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA postbro FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA postbro FROM postbro_anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA postbro FROM postbro_anon;

GRANT USAGE ON SCHEMA postbro TO postbro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA postbro TO postbro_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA postbro TO postbro_app;
REVOKE ALL ON postbro.schema_migrations FROM postbro_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA postbro REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA postbro REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA postbro GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO postbro_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA postbro GRANT USAGE ON SEQUENCES TO postbro_app;
