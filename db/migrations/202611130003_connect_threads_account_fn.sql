-- PB-P0-003 slice D2b1: persist a simulated OAuth completion (account
-- connect / reconnect) atomically and safely under RLS.
--
-- Problem: the threads_accounts / operator_accounts RLS policies are scoped
-- by postbro.account_id, which is unknown for a NOT-YET-CREATED account, and
-- a provider_id row owned by a different operator is invisible under a plain
-- operator-scoped session. A plain check-then-upsert from the app role would
-- either fail the WITH CHECK on first connect or risk cross-operator
-- takeover races.
--
-- Solution: a single SECURITY DEFINER function owned by the migration role
-- (table owner, bypasses RLS) that performs the whole connect atomically:
--   1. verifies the operator exists and is active;
--   2. locks any existing threads_accounts row for the provider id
--      (SELECT ... FOR UPDATE) so concurrent connects serialize;
--   3. if the row exists, requires an operator_accounts binding for the SAME
--      operator (same-owner reconnect) — otherwise raises
--      'provider_owned_by_other_operator' and changes nothing;
--   4. inserts or updates the account row with new ciphertext/key id/expiry
--      and ONLY verified granted scopes, and ensures the ownership binding.
-- The function runs in the caller's transaction, so any failure rolls back
-- cleanly with no partial rows or bindings.
--
-- Granted EXECUTE to postbro_app only; never to postbro_anon. Token material
-- must already be encrypted by the caller; this function stores bytes as
-- given and never logs them.

CREATE OR REPLACE FUNCTION postbro.connect_threads_account(
  p_operator_id bigint,
  p_provider_id text,
  p_username text,
  p_scopes text[],
  p_token_ciphertext bytea,
  p_token_key_id text,
  p_token_expires_at timestamptz
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = postbro, pg_catalog
AS $$
DECLARE
  v_account_id bigint;
  v_owner_id bigint;
BEGIN
  IF p_operator_id IS NULL OR p_provider_id IS NULL OR length(p_provider_id) = 0 THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_token_ciphertext IS NULL OR octet_length(p_token_ciphertext) = 0 THEN
    RAISE EXCEPTION 'invalid_ciphertext' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM postbro.operators
   WHERE id = p_operator_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_inactive' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_account_id FROM postbro.threads_accounts
   WHERE provider_id = p_provider_id
   FOR UPDATE;

  IF v_account_id IS NOT NULL THEN
    SELECT operator_id INTO v_owner_id FROM postbro.operator_accounts
     WHERE account_id = v_account_id AND role = 'owner'
     LIMIT 1;
    IF v_owner_id IS DISTINCT FROM p_operator_id THEN
      RAISE EXCEPTION 'provider_owned_by_other_operator' USING ERRCODE = '42501';
    END IF;
    UPDATE postbro.threads_accounts
       SET username = p_username,
           scopes = COALESCE(p_scopes, '{}'),
           token_ciphertext = p_token_ciphertext,
           token_key_id = p_token_key_id,
           token_expires_at = p_token_expires_at,
           status = 'active',
           updated_at = now()
     WHERE id = v_account_id;
  ELSE
    INSERT INTO postbro.threads_accounts
      (provider_id, username, scopes, token_ciphertext, token_key_id, token_expires_at)
    VALUES
      (p_provider_id, p_username, COALESCE(p_scopes, '{}'),
       p_token_ciphertext, p_token_key_id, p_token_expires_at)
    RETURNING id INTO v_account_id;

    INSERT INTO postbro.operator_accounts (operator_id, account_id, role)
    VALUES (p_operator_id, v_account_id, 'owner');
  END IF;

  RETURN v_account_id;
END;
$$;

REVOKE ALL ON FUNCTION postbro.connect_threads_account(bigint, text, text, text[], bytea, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION postbro.connect_threads_account(bigint, text, text, text[], bytea, text, timestamptz) TO postbro_app;
