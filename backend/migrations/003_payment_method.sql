-- Cash / online split. A day's revenue is entered as two parts; amount stays
-- as their (generated) total so every existing sum keeps working. Expenses and
-- handovers are paid one way or the other; everything before this was cash.
ALTER TABLE daily_revenues
    ADD COLUMN cash   numeric(12, 2) NOT NULL DEFAULT 0 CHECK (cash >= 0),
    ADD COLUMN online numeric(12, 2) NOT NULL DEFAULT 0 CHECK (online >= 0);
UPDATE daily_revenues SET cash = amount;
ALTER TABLE daily_revenues DROP COLUMN amount;
ALTER TABLE daily_revenues ADD COLUMN amount numeric(12, 2) GENERATED ALWAYS AS (cash + online) STORED;

ALTER TABLE expenses ADD COLUMN method text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'online'));
ALTER TABLE partner_handovers ADD COLUMN method text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'online'));
