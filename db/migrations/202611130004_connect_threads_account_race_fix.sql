-- PB-P0-003 review follow-up: close the concurrent first-connect race in
-- postbro.connect_threads_account.
--
-- Race: two concurrent connects for the SAME provider id both run
-- SELECT ... FOR UPDATE before either has inserted, so both observe "no row"
-- and both INSERT. The loser hits the threads_accounts.provider_id unique
-- constraint (SQLSTATE 23505) instead of the deterministic
-- 'provider_owned_by_other_operator' ownership error the function contract
-- (and persist-oauth concurrent test) requires.
--
-- Fix: wrap the insert branch in a subtransaction; on unique_violation,
-- re-lock the now-visible winner row FOR UPDATE and apply the same ownership
-- check / same-owner update path as the existing-row branch. Ownership
-- semantics are unchanged; only the race outcome becomes deterministic.
-- Forward-only: the original function body in
-- 202611130003_connect_threads_account_fn.sql is left untouched.

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
    BEGIN
      INSERT INTO postbro.threads_accounts
        (provider_id, username, scopes, token_ciphertext, token_key_id, token_expires_at)
      VALUES
        (p_provider_id, p_username, COALESCE(p_scopes, '{}'),
         p_token_ciphertext, p_token_key_id, p_token_expires_at)
      RETURNING id INTO v_account_id;

      INSERT INTO postbro.operator_accounts (operator_id, account_id, role)
      VALUES (p_operator_id, v_account_id, 'owner');
    EXCEPTION
      WHEN unique_violation THEN
        -- Concurrent first-connect for the same provider id: both
        -- transactions saw no row under FOR UPDATE, one inserted, this one
        -- hit the provider_id unique constraint. Re-lock the winner row and
        -- enforce the identical ownership contract deterministically.
        SELECT id INTO v_account_id FROM postbro.threads_accounts
         WHERE provider_id = p_provider_id
         FOR UPDATE;
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
    END;
  END IF;

  RETURN v_account_id;
END;
$$;

REVOKE ALL ON FUNCTION postbro.connect_threads_account(bigint, text, text, text[], bytea, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION postbro.connect_threads_account(bigint, text, text, text[], bytea, text, timestamptz) TO postbro_app;
