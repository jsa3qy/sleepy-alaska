-- Migration: Add voting system and regions for trip planning
-- Run this in your Supabase SQL Editor

-- ============================================
-- 1. Create regions table
-- ============================================
CREATE TABLE IF NOT EXISTS regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  -- Approximate center point for reference
  center_lat DOUBLE PRECISION,
  center_lng DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert the defined regions
INSERT INTO regions (name, description, center_lat, center_lng) VALUES
  ('Anchorage Area', 'Greater Anchorage including Girdwood', 61.2181, -149.9003),
  ('Seward Area', 'Seward and Kenai Fjords region', 60.1042, -149.4422),
  ('North of Anchorage', 'Palmer, Wasilla, Talkeetna, and Denali access', 61.6, -149.4),
  ('Kenai Peninsula', 'Homer, Soldotna, and the rest of the peninsula', 60.5, -150.5)
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 2. Add region_id to pins table
-- ============================================
ALTER TABLE pins
ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES regions(id);

-- ============================================
-- 3. Create vote_tiers enum type
-- ============================================
DO $$ BEGIN
  CREATE TYPE vote_tier AS ENUM (
    'highly_interested',    -- Counts as 1
    'would_do_with_group',  -- Counts as 1
    'want_more_info',       -- Counts as 0
    'not_interested'        -- Counts as 0
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ============================================
-- 4. Create user_votes table
-- ============================================
CREATE TABLE IF NOT EXISTS user_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pin_id UUID NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
  vote vote_tier NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Each user can only vote once per pin
  UNIQUE(user_id, pin_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_votes_pin_id ON user_votes(pin_id);
CREATE INDEX IF NOT EXISTS idx_user_votes_user_id ON user_votes(user_id);

-- ============================================
-- 5. Row Level Security (RLS) Policies
-- ============================================

-- Enable RLS on user_votes
ALTER TABLE user_votes ENABLE ROW LEVEL SECURITY;

-- Users can read all votes (needed for aggregation)
CREATE POLICY "Users can view all votes"
  ON user_votes FOR SELECT
  TO authenticated
  USING (true);

-- Users can only insert their own votes
CREATE POLICY "Users can insert own votes"
  ON user_votes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own votes
CREATE POLICY "Users can update own votes"
  ON user_votes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own votes
CREATE POLICY "Users can delete own votes"
  ON user_votes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Enable RLS on regions (read-only for users)
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view regions"
  ON regions FOR SELECT
  TO authenticated
  USING (true);

-- ============================================
-- 6. Helper function to update updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_votes_updated_at
  BEFORE UPDATE ON user_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 7. View for aggregated vote counts per pin
-- ============================================
CREATE OR REPLACE VIEW pin_vote_summary AS
SELECT
  p.id as pin_id,
  p.name as pin_name,
  r.name as region_name,
  r.id as region_id,
  -- Count votes that count as "1" (highly_interested or would_do_with_group)
  COUNT(CASE WHEN v.vote IN ('highly_interested', 'would_do_with_group') THEN 1 END) as positive_votes,
  -- Total votes
  COUNT(v.id) as total_votes,
  -- Breakdown by tier
  COUNT(CASE WHEN v.vote = 'highly_interested' THEN 1 END) as highly_interested_count,
  COUNT(CASE WHEN v.vote = 'would_do_with_group' THEN 1 END) as would_do_count,
  COUNT(CASE WHEN v.vote = 'want_more_info' THEN 1 END) as want_info_count,
  COUNT(CASE WHEN v.vote = 'not_interested' THEN 1 END) as not_interested_count
FROM pins p
LEFT JOIN regions r ON p.region_id = r.id
LEFT JOIN user_votes v ON p.id = v.pin_id
GROUP BY p.id, p.name, r.name, r.id;
