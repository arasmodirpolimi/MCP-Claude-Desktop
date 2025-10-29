import { createClient } from '@supabase/supabase-js';

// Expect these to be defined at build time (GitHub Pages injects via workflow)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && !/placeholder/i.test(supabaseUrl) && !/placeholder/i.test(supabaseAnonKey)
);

if (!isSupabaseConfigured) {
  console.warn('[Supabase] Configuration missing or placeholder values detected. Login/Signup will be disabled.');
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : {
      auth: {
        // Provide stub methods so calling code can check configuration
        signInWithPassword: async () => ({ error: { message: 'Supabase not configured.' } }),
        signOut: async () => ({ error: { message: 'Supabase not configured.' } }),
        getSession: async () => ({ data: { session: null }, error: null }),
      },
    };
