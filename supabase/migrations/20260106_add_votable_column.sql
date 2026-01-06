-- Add votable column to pins table
-- This allows overriding whether a pin shows voting buttons
-- NULL = use category default, TRUE = always votable, FALSE = never votable

ALTER TABLE pins ADD COLUMN IF NOT EXISTS votable BOOLEAN DEFAULT NULL;

-- Example: Make a specific Point of Interest votable
-- UPDATE pins SET votable = true WHERE name = 'Exit Glacier';
