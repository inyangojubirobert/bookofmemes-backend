// config/db.js

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config'; // Make sure dotenv is configured to load these variables

// Retrieve credentials from environment variables
const supabaseUrl = process.env.SUPABASE_URL;
// For backend operations, we'll use the service role key for full access
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Basic check to ensure environment variables are loaded
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Supabase URL or SERVICE_ROLE_KEY is missing! Check your .env file.");
  // In a production app, you might want to stop the server from starting here
  // process.exit(1);
}

// Create a Supabase client for backend use (with service_role key)
// This client bypasses Row Level Security and has full admin privileges.
export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false, // Prevents storing session in Node.js, good for stateless server
  },
});

console.log("Supabase client initialized for backend.");

// You might also want to export the SQL client if you still use it for specific purposes
// For example, if you still had other PostgreSQL connection strings for non-Supabase DBs
// import { neon } from '@neondatabase/serverless';
// export const sql = neon(process.env.DATABASE_URL); // Only if you have a separate Neon DB