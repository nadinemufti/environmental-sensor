import { createClient } from '@supabase/supabase-js';

// Supabase anon keys are intentionally public — they're safe to ship in client apps.
// Security lives in Row Level Security (RLS) policies on the database side.
// Using env vars here so rotating keys doesn't require a code change.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL
  ?? 'https://dnvrhloomkjkownjohpv.supabase.co';

const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudnJobG9vbWtqa293bmpvaHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODMxOTUsImV4cCI6MjA4OTE1OTE5NX0.d_17mkOSDqy0ZtBTETYzCrGTRiPb1ybOPgfW5LYk3tQ';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,  // no user login in this app
    autoRefreshToken: false,
  },
});
