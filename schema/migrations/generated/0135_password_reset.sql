-- 0135_password_reset.sql — self-service password reset tokens.
-- Auth tables deliberately have no org_id and no RLS: authentication happens
-- before an organization is selected and is reached only through the trusted
-- server-side auth boundary (same doctrine as auth_sessions).

CREATE TABLE public.auth_password_resets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    network_hash text,
    user_agent_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);

CREATE UNIQUE INDEX auth_password_resets_token_hash ON public.auth_password_resets (token_hash);
CREATE INDEX auth_password_resets_user ON public.auth_password_resets (user_id, expires_at);
CREATE INDEX auth_password_resets_expiry ON public.auth_password_resets (expires_at);
