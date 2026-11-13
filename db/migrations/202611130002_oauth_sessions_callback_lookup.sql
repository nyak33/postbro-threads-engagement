-- PB-P0-003 slice D2a: allow the app role to resolve the INITIATING operator
-- of an OAuth callback from an opaque state hash, without trusting any
-- caller-supplied operator id. The callback flow cannot know the operator
-- before lookup, so the operator-scoped policy alone would hide the row.
--
-- This policy is deliberately narrow:
-- - SELECT only; INSERT/UPDATE/DELETE remain operator-scoped (unchanged).
-- - Exposes ONLY operator_id of UNCONSUMED, unexpired sessions to the app
--   role. The row is then consumed atomically under the resolved operator's
--   RLS context in a single UPDATE that enforces purpose, TTL and one-time
--   use. Consumed or expired rows stay invisible.
-- - Grants no token or account data access; oauth_sessions stores only a
--   SHA-256-derived state hash, never the state itself.

CREATE POLICY postbro_app_oauth_callback_lookup ON postbro.oauth_sessions
  FOR SELECT TO postbro_app
  USING (consumed_at IS NULL AND expires_at > now());
