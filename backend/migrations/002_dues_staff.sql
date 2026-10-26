-- Monthly dues (rent, electricity...): a category can carry a fixed amount and
-- a day of the month. It counts as paid once an expense in that category is
-- dated in the current month.
ALTER TABLE expense_categories
    ADD COLUMN due_amount numeric(12, 2) CHECK (due_amount > 0),
    ADD COLUMN due_day    int CHECK (due_day BETWEEN 1 AND 31),
    ADD CONSTRAINT expense_categories_due_check CHECK ((due_amount IS NULL) = (due_day IS NULL));

-- Staff are available every day unless a leave is recorded for that date.
CREATE TABLE staff (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id    uuid NOT NULL REFERENCES shops ON DELETE CASCADE,
    name       text NOT NULL,
    active     boolean NOT NULL DEFAULT true,
    sort_order int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shop_id, id)
);
CREATE UNIQUE INDEX staff_name_key ON staff (shop_id, lower(name));

CREATE TABLE staff_leaves (
    shop_id    uuid NOT NULL,
    staff_id   uuid NOT NULL,
    leave_date date NOT NULL,
    note       text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (staff_id, leave_date),
    FOREIGN KEY (shop_id, staff_id) REFERENCES staff (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX staff_leaves_shop_date_idx ON staff_leaves (shop_id, leave_date);
