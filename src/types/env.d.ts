declare namespace NodeJS {
  interface ProcessEnv {
    ADMIN_API_KEY?: string
    AUTH_TOKEN_SECRET?: string
    AUTH_CLIENT_ID?: string
    AUTH_CLIENT_SECRET?: string
    AUTH_USE_DB_CLIENTS?: string
    EVENT_NOTIFY_FUNCTION?: string
    CMP_PLAN_CHANGE_WEBHOOK_URL?: string
    CMP_PLAN_CHANGE_WEBHOOK_KEY?: string
    OIDC_ISSUER?: string
    OIDC_AUDIENCE?: string
    OIDC_JWKS_URL?: string
    OIDC_JWKS_CACHE_TTL_MS?: string
    OIDC_CLOCK_SKEW_SECONDS?: string
    SUPABASE_URL?: string
    SUPABASE_SERVICE_ROLE_KEY?: string
  }
}
