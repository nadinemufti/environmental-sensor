import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  'https://dnvrhloomkjkownjohpv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudnJobG9vbWtqa293bmpvaHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODMxOTUsImV4cCI6MjA4OTE1OTE5NX0.d_17mkOSDqy0ZtBTETYzCrGTRiPb1ybOPgfW5LYk3tQ'
);
