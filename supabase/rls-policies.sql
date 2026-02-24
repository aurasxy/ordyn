-- SOLUS RLS Policies
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- ============================================
-- 1. ANNOUNCEMENTS — read-only for anon
-- ============================================
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- Drop any existing policies to start clean
DROP POLICY IF EXISTS "anon_select_announcements" ON announcements;
DROP POLICY IF EXISTS "anon_insert_announcements" ON announcements;
DROP POLICY IF EXISTS "anon_update_announcements" ON announcements;
DROP POLICY IF EXISTS "anon_delete_announcements" ON announcements;

-- Allow anyone to read active announcements
CREATE POLICY "anon_select_announcements" ON announcements
  FOR SELECT USING (true);

-- ============================================
-- 2. FEEDBACK — insert-only for anon
-- ============================================
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_feedback" ON feedback;
DROP POLICY IF EXISTS "anon_insert_feedback" ON feedback;
DROP POLICY IF EXISTS "anon_update_feedback" ON feedback;
DROP POLICY IF EXISTS "anon_delete_feedback" ON feedback;

-- Allow anyone to submit feedback
CREATE POLICY "anon_insert_feedback" ON feedback
  FOR INSERT WITH CHECK (true);

-- ============================================
-- 3. ERROR_REPORTS — insert-only for anon
-- ============================================
ALTER TABLE error_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_error_reports" ON error_reports;
DROP POLICY IF EXISTS "anon_insert_error_reports" ON error_reports;
DROP POLICY IF EXISTS "anon_update_error_reports" ON error_reports;
DROP POLICY IF EXISTS "anon_delete_error_reports" ON error_reports;

-- Allow anyone to submit error reports
CREATE POLICY "anon_insert_error_reports" ON error_reports
  FOR INSERT WITH CHECK (true);

-- ============================================
-- 4. EVENTS — insert-only for anon
-- ============================================
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_events" ON events;
DROP POLICY IF EXISTS "anon_insert_events" ON events;
DROP POLICY IF EXISTS "anon_update_events" ON events;
DROP POLICY IF EXISTS "anon_delete_events" ON events;

-- Allow anyone to submit telemetry events
CREATE POLICY "anon_insert_events" ON events
  FOR INSERT WITH CHECK (true);

-- ============================================
-- 5. DISCORD TABLES — service_role only
--    (RLS enabled but no anon policies = blocked)
-- ============================================
ALTER TABLE discord_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_orders ENABLE ROW LEVEL SECURITY;

-- Drop any accidental anon policies on discord tables
DROP POLICY IF EXISTS "anon_select_discord_links" ON discord_links;
DROP POLICY IF EXISTS "anon_insert_discord_links" ON discord_links;
DROP POLICY IF EXISTS "anon_update_discord_links" ON discord_links;
DROP POLICY IF EXISTS "anon_delete_discord_links" ON discord_links;
DROP POLICY IF EXISTS "anon_select_discord_channels" ON discord_channels;
DROP POLICY IF EXISTS "anon_insert_discord_channels" ON discord_channels;
DROP POLICY IF EXISTS "anon_update_discord_channels" ON discord_channels;
DROP POLICY IF EXISTS "anon_delete_discord_channels" ON discord_channels;
DROP POLICY IF EXISTS "anon_select_discord_orders" ON discord_orders;
DROP POLICY IF EXISTS "anon_insert_discord_orders" ON discord_orders;
DROP POLICY IF EXISTS "anon_update_discord_orders" ON discord_orders;
DROP POLICY IF EXISTS "anon_delete_discord_orders" ON discord_orders;

-- No anon policies = anon key is fully blocked.
-- Edge Functions use service_role which bypasses RLS.

-- ============================================
-- 6. STORAGE — feedback-images bucket
-- ============================================
-- Allow anon uploads only (no read/list/delete)
DROP POLICY IF EXISTS "anon_upload_feedback_images" ON storage.objects;
DROP POLICY IF EXISTS "anon_select_feedback_images" ON storage.objects;
DROP POLICY IF EXISTS "anon_delete_feedback_images" ON storage.objects;

CREATE POLICY "anon_upload_feedback_images" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'feedback-images'
  );

-- ============================================
-- DONE. Verify with:
-- SELECT tablename, policyname, cmd FROM pg_policies ORDER BY tablename;
-- ============================================
