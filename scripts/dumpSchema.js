// Refreshes database-schema.json (repo root) from the live database.
// Needs migration 066 (schema_dump function). Run from Backend/:
//   node --env-file=.env scripts/dumpSchema.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed (run with --env-file=.env)'); process.exit(1); }

const res = await fetch(`${url}/rest/v1/rpc/schema_dump`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const body = await res.json();
if (!res.ok) { console.error('schema_dump failed:', body.message || body); console.error('Has migration 066 been run?'); process.exit(1); }

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../database-schema.json');
fs.writeFileSync(out, JSON.stringify([{ schema_dump: body }], null, 2));
const n = (k) => (body[k] || []).length;
console.log(`Wrote ${out}: ${n('tables')} tables, ${n('foreign_keys')} foreign keys, ${n('rls_policies')} policies, ${n('triggers')} triggers, ${n('functions')} functions.`);
