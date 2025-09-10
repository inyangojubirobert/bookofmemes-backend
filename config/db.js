// config/db.js
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// Validate critical environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required Supabase environment variables: ${missingVars.join(', ')}\n` +
    'Please check your .env file and server configuration.'
  );
}

// Initialize Supabase client with enhanced configuration
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false, // Recommended for server-side usage
      autoRefreshToken: false,
    },
    db: {
      schema: 'public', // Specify your database schema
    },
    global: {
      headers: {
        'X-Application-Name': 'your-app-name', // For tracking in Supabase logs
      },
    },
  }
);

// Test connection on startup (optional but recommended)
(async () => {
  try {
    const { data, error } = await supabase
      .from('stories')
      .select('id')
      .limit(1);
    
    if (error) throw error;
    console.log('✅ Supabase connected successfully');
  } catch (error) {
    console.error('❌ Supabase connection test failed:', error.message);
    process.exit(1); // Terminate if DB connection fails
  }
})();

// Utility function for error handling
export const handleSupabaseError = (error) => {
  console.error('Supabase Error:', {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  });
  throw new Error('Database operation failed');
};