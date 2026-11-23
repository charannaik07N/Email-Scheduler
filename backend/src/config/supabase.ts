import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing Supabase configuration: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see backend/.env.example).'
  );
}

/**
 * Server-side client using the service role key. It bypasses row-level security,
 * so every query must filter by the authenticated user itself.
 */
export const supabaseServiceClient: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
