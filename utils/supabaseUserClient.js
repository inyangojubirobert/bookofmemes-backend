import { createClient } from '@supabase/supabase-js';

// spend_tokens() and any other SECURITY DEFINER RPC keyed off auth.uid()
// (migrations/017_title_charging_and_user_quiz.sql) only resolves the caller
// when the request carries THAT user's own JWT. Backend/config/db.js's
// exported `supabase` uses the service-role key instead, which has no user
// JWT and would make auth.uid() resolve to NULL. This builds a short-lived
// client authenticated as one specific user so existing atomic, user-scoped
// RPCs can be reused correctly from backend routes instead of being
// reimplemented with a race-prone read-then-update.
export function userScopedClient(userAccessToken) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${userAccessToken}` } },
  });
}

// Pulls the bearer token off an already-authenticateToken-verified request.
export function tokenFromRequest(req) {
  return req.headers.authorization.replace('Bearer ', '');
}
