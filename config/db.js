// config/db.js
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// Determine environment
const isServer = typeof window === 'undefined';

// Grab environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Debug logging
console.log('--- Supabase Environment Check ---');
console.log('Supabase URL:', SUPABASE_URL ? '✅ SET' : '❌ MISSING');
console.log('Server key:', SUPABASE_SERVICE_ROLE_KEY ? '✅ SET' : '❌ MISSING');
console.log('Anon key:', SUPABASE_ANON_KEY ? '✅ SET' : '❌ MISSING');
console.log('Running on server:', isServer);
console.log('---------------------------------');

// Validate environment
if (!SUPABASE_URL) {
  console.error('❌ Supabase connection failed: Missing SUPABASE_URL');
  process.exit(1);
}
if (isServer && !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Supabase connection failed: Missing SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!isServer && !SUPABASE_ANON_KEY) {
  console.error('❌ Supabase connection failed: Missing SUPABASE_ANON_KEY');
  process.exit(1);
}

// Choose key
const key = isServer ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY;

// Initialize Supabase client
export const supabase = createClient(SUPABASE_URL, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  db: {
    schema: 'public',
  },
  global: {
    headers: {
      'X-Application-Name': 'bookofmemes-server',
    },
  },
});

// Confirm connection setup (not testing the key)
console.log(`✅ Supabase client initialized using ${isServer ? 'Service Role Key' : 'Anon Key'}`);

// Optional helper
export const handleSupabaseError = (error) => {
  console.error('Supabase Error:', {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  });
  throw new Error('Database operation failed');
};
