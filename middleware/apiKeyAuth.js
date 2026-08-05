import { supabase } from "../config/db.js";

// Validates X-API-Key header against wallet_api_keys table.
// Also accepts Supabase user JWT (Authorization: Bearer) for user context.
// Sets req.apiApp (the app record) and optionally req.user (the Supabase user).
export const apiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing X-API-Key header" });

  const { data: app, error } = await supabase
    .from("wallet_api_keys")
    .select("*")
    .eq("api_key", apiKey)
    .eq("is_active", true)
    .single();

  if (error || !app) return res.status(401).json({ error: "Invalid or inactive API key" });

  req.apiApp = app;

  // Optionally resolve user from Bearer token (for user-scoped operations)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabase.auth.getUser(token);
    if (data?.user) req.user = data.user;
  }

  // Server-to-server: caller can pass X-User-Id instead of Bearer token
  if (!req.user && req.headers["x-user-id"]) {
    req.user = { id: req.headers["x-user-id"] };
  }

  next();
};

// Guard: ensure req.user is present (some wallet routes require a user)
export const requireUser = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "User identity required (Bearer token or X-User-Id)" });
  next();
};

// Guard: check API key has a specific permission
export const requirePermission = (permission) => (req, res, next) => {
  if (!req.apiApp?.permissions?.includes(permission)) {
    return res.status(403).json({ error: `API key missing permission: ${permission}` });
  }
  next();
};
