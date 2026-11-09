-- Cash counts: a scratch log of "I counted the drawer and found this much".
-- Not part of any total; ids may be client-generated for offline sync.
CREATE TABLE cash_counts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id    uuid NOT NULL REFERENCES shops ON DELETE CASCADE,
    counted_at timestamptz NOT NULL,
    amount     numeric(12, 2) NOT NULL CHECK (amount >= 0),
    note       text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_counts_shop_idx ON cash_counts (shop_id, counted_at DESC);
