-- A monthly due or salary can be ignored for one month: Home hides it while
-- due_ignored is the first day of the current month.
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS due_ignored date;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS due_ignored date;
