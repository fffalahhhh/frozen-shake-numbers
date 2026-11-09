-- Monthly salary per staff member, same shape as a category's due. It counts
-- as paid once a Salaries expense noting their name is dated in the month.
ALTER TABLE staff
    ADD COLUMN due_amount numeric(12, 2) CHECK (due_amount > 0),
    ADD COLUMN due_day    int CHECK (due_day BETWEEN 1 AND 31),
    ADD CONSTRAINT staff_due_check CHECK ((due_amount IS NULL) = (due_day IS NULL));
