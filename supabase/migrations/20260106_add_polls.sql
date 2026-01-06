-- Migration: Add general polls system for trip preferences
-- Run this in your Supabase SQL Editor

-- ============================================
-- 1. Create polls table
-- ============================================
CREATE TABLE IF NOT EXISTS polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  description TEXT,
  sort_order INT DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert the default poll questions
INSERT INTO polls (question, description, sort_order) VALUES
  ('Backpacking overnight', 'Carry all gear, but we can help you fill in the gear you don''t have', 1),
  ('Tent camping at a campground', 'Campground with amenities (bathrooms, access to food/cars)', 2),
  ('Backpacking to a FCFS hut', 'Hike to a first-come-first-served hut and sleep overnight', 3),
  ('Day Hikes (moderate)', 'Up to 10 miles, up to 3000ft elevation gain', 4),
  ('Strenuous Day Hikes', '5-10 miles with 3000+ ft of elevation gain', 5);

-- ============================================
-- 2. Create poll_votes table
-- ============================================
CREATE TABLE IF NOT EXISTS poll_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  vote vote_tier NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Each user can only vote once per poll
  UNIQUE(user_id, poll_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user_id ON poll_votes(user_id);

-- ============================================
-- 3. Row Level Security (RLS) Policies
-- ============================================

-- Enable RLS on polls
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can view polls
CREATE POLICY "Users can view all polls"
  ON polls FOR SELECT
  TO authenticated
  USING (true);

-- Anyone authenticated can create polls
CREATE POLICY "Users can create polls"
  ON polls FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Anon can also read polls (for consistency with other tables)
CREATE POLICY "Anon can view polls"
  ON polls FOR SELECT
  TO anon
  USING (true);

-- Enable RLS on poll_votes
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;

-- Users can read all poll votes (needed for aggregation)
CREATE POLICY "Users can view all poll votes"
  ON poll_votes FOR SELECT
  TO authenticated
  USING (true);

-- Users can only insert their own poll votes
CREATE POLICY "Users can insert own poll votes"
  ON poll_votes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own poll votes
CREATE POLICY "Users can update own poll votes"
  ON poll_votes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own poll votes
CREATE POLICY "Users can delete own poll votes"
  ON poll_votes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================
-- 4. Trigger for updated_at
-- ============================================
CREATE TRIGGER update_poll_votes_updated_at
  BEFORE UPDATE ON poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
