-- Agent Library (goal #9): categorize and feature agent profiles so discovery
-- scales past a flat grid. NULL category = uncategorized (shown under "All").
ALTER TABLE profiles ADD COLUMN category TEXT;
ALTER TABLE profiles ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
