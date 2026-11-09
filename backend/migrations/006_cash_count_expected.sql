-- The app's cash in hand when a count was made, so the list can show short /
-- extra / matches later. NULL for counts saved before this existed.
ALTER TABLE cash_counts ADD COLUMN IF NOT EXISTS expected numeric(12, 2);
