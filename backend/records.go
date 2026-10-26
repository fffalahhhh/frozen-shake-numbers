package main

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---------- Revenue: one total per shop per day ----------

func (a *app) listRevenue(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	from, err := optDate(r, "from")
	if err != nil {
		return err
	}
	to, err := optDate(r, "to")
	if err != nil {
		return err
	}
	limit := 1000
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v < limit {
		limit = v
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT business_date::text, amount::text, updated_at FROM daily_revenues
		WHERE shop_id = $1 AND ($2::date IS NULL OR business_date >= $2) AND ($3::date IS NULL OR business_date <= $3)
		ORDER BY business_date DESC LIMIT $4`, sc.ID, from, to, limit)
	if err != nil {
		return err
	}
	type rev struct {
		Date      string    `json:"date"`
		Amount    string    `json:"amount"`
		UpdatedAt time.Time `json:"updatedAt"`
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[rev])
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"revenue": out})
}

// putRevenue upserts, so replaying it (offline sync) can never duplicate.
func (a *app) putRevenue(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	date, err := parseDate(r.PathValue("date"))
	if err != nil {
		return err
	}
	var in struct{ Amount Money }
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if in.Amount == "" {
		return invalid("Amount is required")
	}
	var amount string
	var updatedAt time.Time
	if err := a.db.QueryRow(r.Context(), `
		INSERT INTO daily_revenues (shop_id, business_date, amount, updated_by) VALUES ($1, $2, $3, $4)
		ON CONFLICT (shop_id, business_date) DO UPDATE
			SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()
		RETURNING amount::text, updated_at`, sc.ID, date, string(in.Amount), sc.User.ID).Scan(&amount, &updatedAt); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"revenue": map[string]any{"date": date, "amount": amount, "updatedAt": updatedAt}})
}

// ---------- Expenses & partner handovers ----------
// Same shape: amount + date + note + a reference (category / partner) whose
// name is snapshotted on the row so history survives renames.

type txnKind struct {
	table, refTable, ref, label string
}

var (
	expenseKind  = txnKind{"expenses", "expense_categories", "category", "category"}
	handoverKind = txnKind{"partner_handovers", "partners", "partner", "partner"}
)

func (k txnKind) cols() string {
	return fmt.Sprintf(`id, business_date::text, amount::text, %[1]s_id, %[1]s_name, note, created_at, updated_at`, k.ref)
}

func (k txnKind) scan(row pgx.Row) (map[string]any, error) {
	var id, date, amount, refID, refName, note string
	var created, updated time.Time
	if err := row.Scan(&id, &date, &amount, &refID, &refName, &note, &created, &updated); err != nil {
		return nil, err
	}
	return map[string]any{
		"id": id, "date": date, "amount": amount, k.ref + "Id": refID, k.ref + "Name": refName,
		"note": note, "createdAt": created, "updatedAt": updated,
	}, nil
}

type txnInput struct {
	ID         string `json:"id"` // optional client-generated UUID = idempotency key
	Date       string `json:"date"`
	Amount     Money  `json:"amount"`
	CategoryID string `json:"categoryId"`
	PartnerID  string `json:"partnerId"`
	Note       string `json:"note"`
}

// validate checks the input and resolves the reference's current name,
// requiring it to belong to this shop.
func (a *app) validateTxn(r *http.Request, sc shopCtx, k txnKind, in *txnInput) (refID, refName string, err error) {
	if in.ID != "" && !isUUID(in.ID) {
		return "", "", invalid("id must be a UUID")
	}
	if in.Date, err = parseDate(in.Date); err != nil {
		return
	}
	if in.Amount == "" || in.Amount.IsZero() {
		return "", "", invalid("Amount must be more than ₹0")
	}
	if in.Note, err = cleanNote(in.Note); err != nil {
		return
	}
	refID = in.CategoryID
	if k.ref == "partner" {
		refID = in.PartnerID
	}
	if !isUUID(refID) {
		return "", "", invalid("Choose a %s", k.label)
	}
	err = a.db.QueryRow(r.Context(), `SELECT name FROM `+k.refTable+` WHERE id = $1 AND shop_id = $2`, refID, sc.ID).Scan(&refName)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", invalid("Choose a %s", k.label)
	}
	return
}

func (a *app) listTxns(k txnKind) func(http.ResponseWriter, *http.Request, shopCtx) error {
	return func(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
		from, err := optDate(r, "from")
		if err != nil {
			return err
		}
		to, err := optDate(r, "to")
		if err != nil {
			return err
		}
		var refID *string
		if v := r.URL.Query().Get(k.ref + "Id"); v != "" {
			if !isUUID(v) {
				return invalid("Invalid %sId", k.ref)
			}
			refID = &v
		}
		limit := 500
		if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v < limit {
			limit = v
		}
		rows, err := a.db.Query(r.Context(), `SELECT `+k.cols()+` FROM `+k.table+`
			WHERE shop_id = $1 AND ($2::date IS NULL OR business_date >= $2) AND ($3::date IS NULL OR business_date <= $3)
				AND ($4::uuid IS NULL OR `+k.ref+`_id = $4)
			ORDER BY business_date DESC, created_at DESC LIMIT $5`, sc.ID, from, to, refID, limit)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (map[string]any, error) { return k.scan(row) })
		if err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, map[string]any{"items": items})
	}
}

func (a *app) createTxn(k txnKind) func(http.ResponseWriter, *http.Request, shopCtx) error {
	return func(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
		var in txnInput
		if err := decode(w, r, &in); err != nil {
			return err
		}
		refID, refName, err := a.validateTxn(r, sc, k, &in)
		if err != nil {
			return err
		}
		var id any // nil → server generates
		if in.ID != "" {
			id = in.ID
		}
		item, err := k.scan(a.db.QueryRow(r.Context(), `
			INSERT INTO `+k.table+` (id, shop_id, business_date, amount, `+k.ref+`_id, `+k.ref+`_name, note, created_by)
			VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (id) DO NOTHING
			RETURNING `+k.cols(), id, sc.ID, in.Date, string(in.Amount), refID, refName, in.Note, sc.User.ID))
		if err == nil {
			return writeJSON(w, http.StatusCreated, map[string]any{"item": item})
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// The id already exists: a replayed offline submission. Return the
		// stored row if it's ours; never touch another shop's row.
		item, err = k.scan(a.db.QueryRow(r.Context(), `SELECT `+k.cols()+` FROM `+k.table+` WHERE id = $1 AND shop_id = $2`, in.ID, sc.ID))
		if errors.Is(err, pgx.ErrNoRows) {
			return conflict("This id is already in use")
		} else if err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, map[string]any{"item": item})
	}
}

func (a *app) updateTxn(k txnKind) func(http.ResponseWriter, *http.Request, shopCtx) error {
	return func(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		var in txnInput
		if err := decode(w, r, &in); err != nil {
			return err
		}
		in.ID = ""
		refID, refName, err := a.validateTxn(r, sc, k, &in)
		if err != nil {
			return err
		}
		// Keep the original snapshot name unless the reference itself changed.
		item, err := k.scan(a.db.QueryRow(r.Context(), `
			UPDATE `+k.table+` SET business_date = $3, amount = $4,
				`+k.ref+`_name = CASE WHEN `+k.ref+`_id = $5 THEN `+k.ref+`_name ELSE $6 END,
				`+k.ref+`_id = $5, note = $7, updated_at = now()
			WHERE id = $1 AND shop_id = $2
			RETURNING `+k.cols(), id, sc.ID, in.Date, string(in.Amount), refID, refName, in.Note))
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		} else if err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, map[string]any{"item": item})
	}
}

// deleteTxn is idempotent: deleting an already-deleted row is still 204.
func (a *app) deleteTxn(k txnKind) func(http.ResponseWriter, *http.Request, shopCtx) error {
	return func(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		if _, err := a.db.Exec(r.Context(), `DELETE FROM `+k.table+` WHERE id = $1 AND shop_id = $2`, id, sc.ID); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
}

// ---------- Categories & partners ----------
// Never hard-deleted: DELETE deactivates, so historical rows keep their FK.

func (a *app) listCategories(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	rows, err := a.db.Query(r.Context(), `
		SELECT id, name, is_default, active, due_amount::text, due_day FROM expense_categories
		WHERE shop_id = $1 ORDER BY sort_order, created_at`, sc.ID)
	if err != nil {
		return err
	}
	type cat struct {
		ID        string  `json:"id"`
		Name      string  `json:"name"`
		IsDefault bool    `json:"isDefault"`
		Active    bool    `json:"active"`
		DueAmount *string `json:"dueAmount"`
		DueDay    *int32  `json:"dueDay"`
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[cat])
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"categories": out})
}

// putDue sets a category's monthly due ({amount, day}) or clears it ({amount: null}).
func (a *app) putDue(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Amount *Money
		Day    *int
	}
	if err := decode(w, r, &in); err != nil {
		return err
	}
	var amount any // nil clears the due
	if in.Amount != nil {
		if in.Amount.IsZero() {
			return invalid("Amount must be more than ₹0")
		}
		if in.Day == nil || *in.Day < 1 || *in.Day > 31 {
			return invalid("Due day must be 1–31")
		}
		amount = string(*in.Amount)
	} else {
		in.Day = nil
	}
	tag, err := a.db.Exec(r.Context(), `UPDATE expense_categories SET due_amount = $3, due_day = $4 WHERE id = $1 AND shop_id = $2`,
		id, sc.ID, amount, in.Day)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------- Staff leave ----------
// Staff are available by default; a row in staff_leaves marks one day off.

func (a *app) listStaff(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	rows, err := a.db.Query(r.Context(), `SELECT id, name, active FROM staff WHERE shop_id = $1 ORDER BY sort_order, created_at`, sc.ID)
	if err != nil {
		return err
	}
	type staff struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Active bool   `json:"active"`
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[staff])
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"staff": out})
}

func (a *app) listLeaves(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	from, err := optDate(r, "from")
	if err != nil {
		return err
	}
	to, err := optDate(r, "to")
	if err != nil {
		return err
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT staff_id, leave_date::text, note FROM staff_leaves
		WHERE shop_id = $1 AND ($2::date IS NULL OR leave_date >= $2) AND ($3::date IS NULL OR leave_date <= $3)
		ORDER BY leave_date DESC LIMIT 1000`, sc.ID, from, to)
	if err != nil {
		return err
	}
	type leave struct {
		StaffID string `json:"staffId"`
		Date    string `json:"date"`
		Note    string `json:"note"`
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[leave])
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"leaves": out})
}

// putLeave marks a staff member off on a date (upsert, so retries are safe).
func (a *app) putLeave(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	date, err := parseDate(r.PathValue("date"))
	if err != nil {
		return err
	}
	var in struct{ Note string }
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if in.Note, err = cleanNote(in.Note); err != nil {
		return err
	}
	tag, err := a.db.Exec(r.Context(), `
		INSERT INTO staff_leaves (shop_id, staff_id, leave_date, note, created_by)
		SELECT shop_id, id, $3, $4, $5 FROM staff WHERE id = $1 AND shop_id = $2
		ON CONFLICT (staff_id, leave_date) DO UPDATE SET note = EXCLUDED.note`, id, sc.ID, date, in.Note, sc.User.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// deleteLeave is idempotent: the staff member is simply available that day.
func (a *app) deleteLeave(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	date, err := parseDate(r.PathValue("date"))
	if err != nil {
		return err
	}
	if _, err := a.db.Exec(r.Context(), `DELETE FROM staff_leaves WHERE staff_id = $1 AND leave_date = $2 AND shop_id = $3`, id, date, sc.ID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// listPartners includes each partner's handover total, optionally within ?from=&to=.
func (a *app) listPartners(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	from, err := optDate(r, "from")
	if err != nil {
		return err
	}
	to, err := optDate(r, "to")
	if err != nil {
		return err
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT p.id, p.name, p.active, COALESCE(sum(h.amount), 0)::text, count(h.id)
		FROM partners p
		LEFT JOIN partner_handovers h ON h.shop_id = p.shop_id AND h.partner_id = p.id
			AND ($2::date IS NULL OR h.business_date >= $2) AND ($3::date IS NULL OR h.business_date <= $3)
		WHERE p.shop_id = $1
		GROUP BY p.id ORDER BY p.sort_order, p.created_at`, sc.ID, from, to)
	if err != nil {
		return err
	}
	type partner struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		Active        bool   `json:"active"`
		TotalHandover string `json:"totalHandedOver"`
		HandoverCount int64  `json:"handoverCount"`
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[partner])
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"partners": out})
}

func (a *app) createNamed(table, label string) func(http.ResponseWriter, *http.Request, shopCtx) error {
	return func(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
		var in struct{ Name string }
		if err := decode(w, r, &in); err != nil {
			return err
		}
		name, err := cleanName(in.Name, label)
		if err != nil {
			return err
		}
		var id string
		if err := a.db.QueryRow(r.Context(), `
			INSERT INTO `+table+` (shop_id, name, sort_order)
			VALUES ($1, $2, (SELECT COALESCE(max(sort_order), 0) + 1 FROM `+table+` WHERE shop_id = $1))
			RETURNING id`, sc.ID, name).Scan(&id); err != nil {
			return err
		}
		return writeJSON(w, http.StatusCreated, map[string]any{"id": id, "name": name, "active": true})
	}
}

func (a *app) updateNamed(table, label string) func(http.ResponseWriter, *http.Request, shopCtx) error {
	return func(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		var in struct {
			Name   *string
			Active *bool
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if in.Name != nil {
			n, err := cleanName(*in.Name, label)
			if err != nil {
				return err
			}
			in.Name = &n
		}
		var name string
		var active bool
		err = a.db.QueryRow(r.Context(), `
			UPDATE `+table+` SET name = COALESCE($3, name), active = COALESCE($4, active)
			WHERE id = $1 AND shop_id = $2 RETURNING name, active`, id, sc.ID, in.Name, in.Active).Scan(&name, &active)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		} else if err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, map[string]any{"id": id, "name": name, "active": active})
	}
}

func (a *app) deactivateNamed(table string) func(http.ResponseWriter, *http.Request, shopCtx) error {
	return func(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		tag, err := a.db.Exec(r.Context(), `UPDATE `+table+` SET active = false WHERE id = $1 AND shop_id = $2`, id, sc.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
}

// ---------- Summary & history ----------
// Cash in hand is a running, all-time balance: every revenue minus every
// expense minus every partner handover (handovers are not expenses). A day's
// entries are still dated, but a day isn't expected to balance on its own.

type totals struct {
	Revenue    string `json:"revenue"`
	Expenses   string `json:"expenses"`
	Handovers  string `json:"handovers"`
	CashInHand string `json:"cashInHand"`
}

// totalsBefore sums everything dated before `before` (nil = all time) and
// returns the earliest date with any activity.
func (a *app) totalsBefore(ctx context.Context, shopID string, before *string) (t totals, since *string, err error) {
	err = a.db.QueryRow(ctx, `
		SELECT r::text, e::text, h::text, (r - e - h)::text, first::text FROM (SELECT
			(SELECT COALESCE(sum(amount), 0.00) FROM daily_revenues WHERE shop_id = $1 AND ($2::date IS NULL OR business_date < $2)) r,
			(SELECT COALESCE(sum(amount), 0.00) FROM expenses WHERE shop_id = $1 AND ($2::date IS NULL OR business_date < $2)) e,
			(SELECT COALESCE(sum(amount), 0.00) FROM partner_handovers WHERE shop_id = $1 AND ($2::date IS NULL OR business_date < $2)) h,
			LEAST((SELECT min(business_date) FROM daily_revenues WHERE shop_id = $1),
				(SELECT min(business_date) FROM expenses WHERE shop_id = $1),
				(SELECT min(business_date) FROM partner_handovers WHERE shop_id = $1)) first
		) x`, shopID, before).Scan(&t.Revenue, &t.Expenses, &t.Handovers, &t.CashInHand, &since)
	return
}

// summary: all-time totals for the shop.
func (a *app) summary(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	t, since, err := a.totalsBefore(r.Context(), sc.ID, nil)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"summary": t, "since": since})
}

type dayRow struct {
	Date      string `json:"date"`
	Revenue   string `json:"revenue"`
	Expenses  string `json:"expenses"`
	Handovers string `json:"handovers"`
	Net       string `json:"net"`     // revenue − expenses − handovers for that day
	Balance   string `json:"balance"` // cash in hand at the end of that day (running total)
}

// history returns one row per date that has any activity in [from, to].
func (a *app) history(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	from, err := parseDate(r.URL.Query().Get("from"))
	if err != nil {
		return invalid("from: Date must be YYYY-MM-DD")
	}
	to, err := parseDate(r.URL.Query().Get("to"))
	if err != nil {
		return invalid("to: Date must be YYYY-MM-DD")
	}
	before, _, err := a.totalsBefore(r.Context(), sc.ID, &from)
	if err != nil {
		return err
	}
	opening := before.CashInHand
	rows, err := a.db.Query(r.Context(), `
		WITH rev AS (
			SELECT business_date d, amount FROM daily_revenues
			WHERE shop_id = $1 AND business_date BETWEEN $2 AND $3
		), exp AS (
			SELECT business_date d, sum(amount) amount FROM expenses
			WHERE shop_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY 1
		), ho AS (
			SELECT business_date d, sum(amount) amount FROM partner_handovers
			WHERE shop_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY 1
		), t AS (
			SELECT d, COALESCE(rev.amount, 0.00) r, COALESCE(exp.amount, 0.00) e, COALESCE(ho.amount, 0.00) h
			FROM rev FULL JOIN exp USING (d) FULL JOIN ho USING (d)
		)
		SELECT d::text, r::text, e::text, h::text, (r - e - h)::text,
			($4::numeric + sum(r - e - h) OVER (ORDER BY d))::text
		FROM t ORDER BY d DESC`, sc.ID, from, to, opening)
	if err != nil {
		return err
	}
	days, err := pgx.CollectRows(rows, pgx.RowToStructByPos[dayRow])
	if err != nil {
		return err
	}
	var rev, exp, ho, net string
	for _, d := range days {
		rev, exp, ho, net = addMoney(rev, d.Revenue), addMoney(exp, d.Expenses), addMoney(ho, d.Handovers), addMoney(net, d.Net)
	}
	if days == nil {
		days = []dayRow{}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"days": days, "totals": map[string]string{
		"revenue": addMoney(rev, "0"), "expenses": addMoney(exp, "0"), "handovers": addMoney(ho, "0"),
		"net": addMoney(net, "0"), "openingBalance": addMoney(opening, "0"), "closingBalance": addMoney(opening, net),
	}})
}

// addMoney adds two decimal strings exactly (big.Rat, no float rounding).
func addMoney(x, y string) string {
	a, b := new(big.Rat), new(big.Rat)
	if _, ok := a.SetString(x); !ok {
		a.SetInt64(0)
	}
	if _, ok := b.SetString(y); !ok {
		b.SetInt64(0)
	}
	return a.Add(a, b).FloatString(2)
}
