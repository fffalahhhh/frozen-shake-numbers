package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2/google"
)

// ---------- Google Sheets mirror ----------
// Each linked shop has one spreadsheet that mirrors all of its data, Summary
// tab first. It is one-way: every sync rebuilds the app's tabs from the DB in a
// single atomic batchUpdate, so deletes and renames can't drift and a failed
// sync heals on the next one. Tabs the app doesn't name are never touched.
//
// Config: GOOGLE_SA_JSON = a service account's JSON key; GOOGLE_SHEETS =
// "shopId=sheetURLorID,shopId=sheetURLorID". Share each sheet with the service
// account's email as Editor. Unset = feature off.

type sheetSync struct {
	client *http.Client
	sheets map[string]string // shop id → spreadsheet id
	mu     sync.Mutex
	dirty  map[string]bool
}

var sheetIDRe = regexp.MustCompile(`/d/([\w-]+)`)

func newSheetSync(keyJSON, links string) (*sheetSync, error) {
	if keyJSON == "" || links == "" {
		return nil, nil
	}
	cfg, err := google.JWTConfigFromJSON([]byte(keyJSON), "https://www.googleapis.com/auth/spreadsheets")
	if err != nil {
		return nil, fmt.Errorf("GOOGLE_SA_JSON: %w", err)
	}
	s := &sheetSync{client: cfg.Client(context.Background()), sheets: map[string]string{}, dirty: map[string]bool{}}
	for _, pair := range strings.Split(links, ",") {
		shop, sheet, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if m := sheetIDRe.FindStringSubmatch(sheet); m != nil {
			sheet = m[1]
		}
		if !ok || !isUUID(shop) || sheet == "" {
			return nil, fmt.Errorf("GOOGLE_SHEETS: want shopId=sheetURL, got %q", pair)
		}
		s.sheets[shop] = sheet
	}
	log.Printf("sheets: mirroring %d shop(s); share each sheet with %s as Editor", len(s.sheets), cfg.Email)
	return s, nil
}

// mark queues a shop for the next sync. Safe on a nil *sheetSync (feature off).
func (s *sheetSync) mark(shopID string) {
	if s == nil || s.sheets[shopID] == "" {
		return
	}
	s.mu.Lock()
	s.dirty[shopID] = true
	s.mu.Unlock()
}

// runSheetSync syncs every linked shop once (covers changes made while the
// server was down), then each tick syncs the shops changed since the last one.
// The tick doubles as debounce and keeps us well under Google's 60 writes/min.
// ponytail: one process, in-memory queue; claim shops via the DB if the API ever runs as several replicas.
func (a *app) runSheetSync() {
	for id := range a.sheets.sheets {
		a.sheets.mark(id)
	}
	for ; ; time.Sleep(15 * time.Second) {
		a.sheets.mu.Lock()
		batch := a.sheets.dirty
		a.sheets.dirty = map[string]bool{}
		a.sheets.mu.Unlock()
		for id := range batch {
			err := a.syncSheet(id)
			var ge *googleError
			switch {
			case err == nil:
			case errors.Is(err, pgx.ErrNoRows): // shop deleted: its sheet stays as an archive
			case errors.As(err, &ge) && ge.status != http.StatusTooManyRequests && ge.status < 500:
				log.Printf("sheets: shop %s: %v (not retrying until the next change)", id, err)
			default:
				log.Printf("sheets: shop %s: %v (retrying)", id, err)
				a.sheets.mark(id)
			}
		}
	}
}

func (a *app) syncSheet(shopID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	tabs, err := a.buildWorkbook(ctx, shopID, time.Now())
	if err != nil {
		return err
	}
	return a.sheets.write(ctx, a.sheets.sheets[shopID], tabs)
}

// ---------- Workbook contents ----------

type tab struct {
	name   string
	header bool // freeze and filter the first row
	rows   [][]any
}

// Cell kinds; plain strings and ints are written as they are.
type (
	bold  string
	money string // decimal string from Postgres; "" = blank
	day   string // YYYY-MM-DD
	month string // YYYY-MM-DD, shown as "Nov 2026"
	stamp time.Time
)

func heads(names ...string) []any {
	row := make([]any, len(names))
	for i, n := range names {
		row[i] = bold(n)
	}
	return row
}

// salaryCats: expenses in a category whose name contains "salar" are salaries,
// as on the Today screen (which only looks at the first active one; here a
// hidden or second Salaries category still counts, so history doesn't vanish).
const salaryCats = `(SELECT id FROM expense_categories WHERE shop_id = $1 AND name ~* 'salar')`

// enteredBy joins users as u: the user's name, or their email if they have none.
const enteredBy = `COALESCE(NULLIF(u.name, ''), u.email, '')`

// query runs sql with args and turns each result row into a sheet row via scan.
func query(ctx context.Context, db pgx.Tx, sql string, args []any, scan func(pgx.CollectableRow) ([]any, error)) ([][]any, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scan)
}

// buildWorkbook reads one shop in a single repeatable-read snapshot, so every
// tab and total agree even if someone saves mid-sync.
func (a *app) buildWorkbook(ctx context.Context, shopID string, now time.Time) ([]tab, error) {
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var name, address, tz string
	if err := tx.QueryRow(ctx, `SELECT name, address, timezone FROM shops WHERE id = $1`, shopID).Scan(&name, &address, &tz); err != nil {
		return nil, err
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	id := []any{shopID}

	// Daily: every active date, newest first, with the running cash in hand.
	daily, err := query(ctx, tx, `
		WITH rev AS (SELECT business_date d, cash, online, amount, updated_by FROM daily_revenues WHERE shop_id = $1),
		exp AS (SELECT business_date d, sum(amount) amount FROM expenses WHERE shop_id = $1 GROUP BY 1),
		ho AS (SELECT business_date d, sum(amount) amount FROM partner_handovers WHERE shop_id = $1 GROUP BY 1),
		t AS (SELECT d, rev.cash, rev.online, COALESCE(rev.amount, 0.00) r, COALESCE(exp.amount, 0.00) e,
				COALESCE(ho.amount, 0.00) h, rev.updated_by
			FROM rev FULL JOIN exp USING (d) FULL JOIN ho USING (d))
		SELECT d::text, cash::text, online::text, r::text, e::text, h::text, (r - e - h)::text,
			(sum(r - e - h) OVER (ORDER BY d))::text, `+enteredBy+`
		FROM t LEFT JOIN users u ON u.id = t.updated_by ORDER BY d DESC`, id,
		func(r pgx.CollectableRow) ([]any, error) {
			var d, rev, exp, ho, net, bal, by string
			var cash, online *string
			err := r.Scan(&d, &cash, &online, &rev, &exp, &ho, &net, &bal, &by)
			return []any{day(d), money(deref(cash)), money(deref(online)), money(rev), money(exp), money(ho), money(net), money(bal), by}, err
		})
	if err != nil {
		return nil, err
	}

	// Expenses, salaries and handovers: one row per entry, newest first.
	entries := func(table, ref, where string) ([][]any, error) {
		return query(ctx, tx, `
			SELECT t.business_date::text, t.`+ref+`_name, t.amount::text, t.method, t.note, `+enteredBy+`
			FROM `+table+` t LEFT JOIN users u ON u.id = t.created_by
			WHERE t.shop_id = $1 `+where+` ORDER BY t.business_date DESC, t.created_at DESC`, id,
			func(r pgx.CollectableRow) ([]any, error) {
				var d, refName, amount, method, note, by string
				err := r.Scan(&d, &refName, &amount, &method, &note, &by)
				return []any{day(d), refName, money(amount), titleCase(method), note, by}, err
			})
	}
	expenses, err := entries("expenses", "category", "")
	if err != nil {
		return nil, err
	}
	handovers, err := entries("partner_handovers", "partner", "")
	if err != nil {
		return nil, err
	}
	salaries, err := entries("expenses", "category", "AND t.category_id IN "+salaryCats)
	if err != nil {
		return nil, err
	}

	// Salaries are matched to staff by name in the note, as on the Today screen.
	var staffNames []string
	staff, err := query(ctx, tx, `
		SELECT s.name, s.active, s.due_amount::text, s.due_day, count(l.leave_date)
		FROM staff s LEFT JOIN staff_leaves l ON l.staff_id = s.id
		WHERE s.shop_id = $1 GROUP BY s.id ORDER BY s.sort_order, s.created_at`, id,
		func(r pgx.CollectableRow) ([]any, error) {
			var n string
			var active bool
			var due *string
			var dueDay *int32
			var leaves int64
			err := r.Scan(&n, &active, &due, &dueDay, &leaves)
			staffNames = append(staffNames, n)
			dd := any("")
			if dueDay != nil {
				dd = int(*dueDay)
			}
			return []any{n, status(active), money(deref(due)), dd, int(leaves)}, err
		})
	if err != nil {
		return nil, err
	}
	for _, row := range salaries {
		row[1] = salaryStaff(row[4].(string), staffNames) // Category column → Staff
	}

	leaves, err := query(ctx, tx, `
		SELECT l.leave_date::text, s.name, l.note, `+enteredBy+`
		FROM staff_leaves l JOIN staff s ON s.id = l.staff_id LEFT JOIN users u ON u.id = l.created_by
		WHERE l.shop_id = $1 ORDER BY l.leave_date DESC, s.sort_order`, id,
		func(r pgx.CollectableRow) ([]any, error) {
			var d, n, note, by string
			err := r.Scan(&d, &n, &note, &by)
			return []any{day(d), n, note, by}, err
		})
	if err != nil {
		return nil, err
	}

	counts, err := query(ctx, tx, `
		SELECT c.counted_at, c.amount::text, c.expected::text, (c.amount - c.expected)::text, c.note, `+enteredBy+`
		FROM cash_counts c LEFT JOIN users u ON u.id = c.created_by
		WHERE c.shop_id = $1 ORDER BY c.counted_at DESC`, id,
		func(r pgx.CollectableRow) ([]any, error) {
			var at time.Time
			var amount, note, by string
			var expected, diff *string
			err := r.Scan(&at, &amount, &expected, &diff, &note, &by)
			return []any{stamp(at.In(loc)), money(amount), money(deref(expected)), money(deref(diff)), note, by}, err
		})
	if err != nil {
		return nil, err
	}

	categories, err := query(ctx, tx, `
		SELECT name, active, due_amount::text, due_day FROM expense_categories
		WHERE shop_id = $1 ORDER BY sort_order, created_at`, id,
		func(r pgx.CollectableRow) ([]any, error) {
			var n string
			var active bool
			var due *string
			var dueDay *int32
			err := r.Scan(&n, &active, &due, &dueDay)
			dd := any("")
			if dueDay != nil {
				dd = int(*dueDay)
			}
			return []any{n, status(active), money(deref(due)), dd}, err
		})
	if err != nil {
		return nil, err
	}

	// ----- Summary -----
	sum := [][]any{
		{bold(name)},
		{address},
		{"Last synced " + now.In(loc).Format("2 Jan 2006, 3:04 pm")},
		{},
		heads("All time", "Total", "Cash", "Online"),
	}
	figures, err := query(ctx, tx, `
		WITH t AS (
			SELECT 'Sales' k, 1 o, amount a, cash c, online n FROM daily_revenues WHERE shop_id = $1
			UNION ALL SELECT 'Expenses', 2, amount, CASE method WHEN 'cash' THEN amount END, CASE method WHEN 'online' THEN amount END FROM expenses WHERE shop_id = $1
			UNION ALL SELECT '  of which salaries', 3, amount, CASE method WHEN 'cash' THEN amount END, CASE method WHEN 'online' THEN amount END FROM expenses WHERE shop_id = $1 AND category_id IN `+salaryCats+`
			UNION ALL SELECT 'Handed over', 4, amount, CASE method WHEN 'cash' THEN amount END, CASE method WHEN 'online' THEN amount END FROM partner_handovers WHERE shop_id = $1
		), k(k, o) AS (VALUES ('Sales', 1), ('Expenses', 2), ('  of which salaries', 3), ('Handed over', 4))
		SELECT k.k, COALESCE(sum(a), 0.00)::text, COALESCE(sum(c), 0.00)::text, COALESCE(sum(n), 0.00)::text
		FROM k LEFT JOIN t USING (k, o) GROUP BY k.k, k.o ORDER BY k.o`, id,
		func(r pgx.CollectableRow) ([]any, error) {
			var k, a, c, n string
			err := r.Scan(&k, &a, &c, &n)
			return []any{k, money(a), money(c), money(n)}, err
		})
	if err != nil {
		return nil, err
	}
	// Cash in hand = sales − expenses − handovers, per column (rows 0, 1, 3).
	inHand := []any{bold("Cash in hand")}
	for c := 1; c <= 3; c++ {
		v := addMoney(string(figures[0][c].(money)), "-"+string(figures[1][c].(money)))
		inHand = append(inHand, money(addMoney(v, "-"+string(figures[3][c].(money)))))
	}
	sum = append(sum, figures...)
	sum = append(sum, inHand)
	if n := len(daily); n > 0 {
		sum = append(sum, []any{"Since", daily[n-1][0]})
	}

	months, err := query(ctx, tx, `
		WITH r AS (SELECT date_trunc('month', business_date) m, sum(cash) c, sum(online) o, sum(amount) t FROM daily_revenues WHERE shop_id = $1 GROUP BY 1),
		e AS (SELECT date_trunc('month', business_date) m, sum(amount) e,
				COALESCE(sum(amount) FILTER (WHERE category_id IN `+salaryCats+`), 0.00) s
			FROM expenses WHERE shop_id = $1 GROUP BY 1),
		h AS (SELECT date_trunc('month', business_date) m, sum(amount) h FROM partner_handovers WHERE shop_id = $1 GROUP BY 1),
		x AS (SELECT m, COALESCE(c, 0.00) c, COALESCE(o, 0.00) o, COALESCE(t, 0.00) t, COALESCE(e, 0.00) e,
				COALESCE(s, 0.00) s, COALESCE(h, 0.00) h
			FROM r FULL JOIN e USING (m) FULL JOIN h USING (m))
		SELECT m::date::text, c::text, o::text, t::text, e::text, s::text, h::text, (t - e - h)::text,
			(sum(t - e - h) OVER (ORDER BY m))::text
		FROM x ORDER BY m DESC`, id,
		func(r pgx.CollectableRow) ([]any, error) {
			var m, c, o, t, e, s, h, net, bal string
			err := r.Scan(&m, &c, &o, &t, &e, &s, &h, &net, &bal)
			return []any{month(m), money(c), money(o), money(t), money(e), money(s), money(h), money(net), money(bal)}, err
		})
	if err != nil {
		return nil, err
	}
	sum = append(sum, []any{}, heads("Month", "Cash sales", "Online sales", "Total sales", "Expenses", "Salaries", "Handed over", "Net", "Cash in hand at end"))
	sum = append(sum, months...)

	// Group totals use the name saved on each entry, so they match the tabs.
	groups := func(table, ref string) ([][]any, error) {
		return query(ctx, tx, `
			SELECT `+ref+`_name, count(*), sum(amount)::text FROM `+table+`
			WHERE shop_id = $1 GROUP BY 1 ORDER BY sum(amount) DESC, 1`, id,
			func(r pgx.CollectableRow) ([]any, error) {
				var n, total string
				var c int64
				err := r.Scan(&n, &c, &total)
				return []any{n, int(c), money(total)}, err
			})
	}
	byCat, err := groups("expenses", "category")
	if err != nil {
		return nil, err
	}
	byPartner, err := groups("partner_handovers", "partner")
	if err != nil {
		return nil, err
	}
	sum = append(sum, []any{}, heads("Expenses by category", "Entries", "Amount"))
	sum = append(sum, byCat...)
	sum = append(sum, []any{}, heads("Handed over by partner", "Entries", "Amount"))
	sum = append(sum, byPartner...)

	// Salaries by staff member and month, from the Salaries tab's rows.
	if len(salaries) > 0 {
		people := slices.Clone(staffNames)
		paid := map[string]map[string]string{} // month → person → total
		var monthsSeen []string
		for _, row := range salaries {
			m, who := string(row[0].(day))[:7]+"-01", row[1].(string)
			if paid[m] == nil {
				paid[m] = map[string]string{}
				monthsSeen = append(monthsSeen, m) // rows are newest first
			}
			paid[m][who] = addMoney(paid[m][who], string(row[2].(money)))
			if !slices.Contains(people, who) {
				people = append(people, who)
			}
		}
		sum = append(sum, []any{}, heads(append([]string{"Salaries by month"}, people...)...))
		for _, m := range monthsSeen {
			row := []any{month(m)}
			for _, p := range people {
				row = append(row, money(paid[m][p]))
			}
			sum = append(sum, row)
		}
	}

	paidBy := []string{"Date", "", "Amount", "Paid by", "Note", "Entered by"}
	with := func(second string) []any { paidBy[1] = second; return heads(paidBy...) }
	return []tab{
		{"Summary", false, sum},
		{"Daily", true, append([][]any{heads("Date", "Cash sales", "Online sales", "Total sales", "Expenses", "Handed over", "Net", "Cash in hand", "Sales entered by")}, daily...)},
		{"Expenses", true, append([][]any{with("Category")}, expenses...)},
		{"Salaries", true, append([][]any{with("Staff")}, salaries...)},
		{"Handovers", true, append([][]any{with("Partner")}, handovers...)},
		{"Staff", true, append([][]any{heads("Name", "Status", "Monthly salary", "Salary day", "Leaves")}, staff...)},
		{"Leaves", true, append([][]any{heads("Date", "Staff", "Note", "Entered by")}, leaves...)},
		{"Cash counts", true, append([][]any{heads("Counted at", "Counted", "App said", "Difference", "Note", "Entered by")}, counts...)},
		{"Categories", true, append([][]any{heads("Name", "Status", "Monthly due", "Due day")}, categories...)},
	}, nil
}

func status(active bool) string {
	if active {
		return "Active"
	}
	return "Hidden"
}

// salaryStaff picks the staff member a salary note names, the way the Today
// screen does (case-insensitive substring). When several match, names that
// are part of another match are dropped ("Ali" inside "Alisha"); if that still
// leaves more than one, or none, the entry is "Unmatched".
func salaryStaff(note string, names []string) string {
	note = strings.ToLower(note)
	var hits []string
	for _, n := range names {
		if n != "" && strings.Contains(note, strings.ToLower(n)) {
			hits = append(hits, n)
		}
	}
	var keep []string
	for _, h := range hits {
		if !slices.ContainsFunc(hits, func(o string) bool {
			return len(o) > len(h) && strings.Contains(strings.ToLower(o), strings.ToLower(h))
		}) {
			keep = append(keep, h)
		}
	}
	if len(keep) == 1 {
		return keep[0]
	}
	return "Unmatched"
}

// ---------- Sheets API ----------

const sheetsAPI = "https://sheets.googleapis.com/v4/spreadsheets/"

type googleError struct {
	status int
	body   string
}

func (e *googleError) Error() string {
	return fmt.Sprintf("google sheets %d: %.300s", e.status, e.body)
}

func (s *sheetSync) call(ctx context.Context, method, url string, body, out any) error {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, url, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return &googleError{res.StatusCode, string(data)}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// write replaces the app's tabs in one batchUpdate (all-or-nothing): missing
// tabs are added first, then each tab is resized and fully overwritten.
// ponytail: one request per sync; split per tab if a shop nears Google's ~2 MB request guideline (~20k entries).
func (s *sheetSync) write(ctx context.Context, spreadsheet string, tabs []tab) error {
	var meta struct {
		Sheets []struct {
			Properties struct {
				SheetID int64  `json:"sheetId"`
				Title   string `json:"title"`
			} `json:"properties"`
		} `json:"sheets"`
	}
	if err := s.call(ctx, "GET", sheetsAPI+spreadsheet+"?fields=sheets.properties(sheetId,title)", nil, &meta); err != nil {
		return err
	}
	ids := map[string]int64{}
	var next int64 = 1
	for _, sh := range meta.Sheets {
		ids[sh.Properties.Title] = sh.Properties.SheetID
		next = max(next, sh.Properties.SheetID+1)
	}
	var reqs []any
	for i, t := range tabs {
		if _, ok := ids[t.name]; ok {
			continue
		}
		ids[t.name] = next
		next++
		reqs = append(reqs,
			map[string]any{"addSheet": map[string]any{"properties": map[string]any{"sheetId": ids[t.name], "title": t.name, "index": i}}},
			map[string]any{"addProtectedRange": map[string]any{"protectedRange": map[string]any{
				"range": map[string]any{"sheetId": ids[t.name]}, "warningOnly": true,
				"description": "Filled by the Frozen Shake app; changes here are overwritten on the next sync.",
			}}})
	}
	for _, t := range tabs {
		id := ids[t.name]
		width := 1
		for _, r := range t.rows {
			width = max(width, len(r))
		}
		frozen := 0
		if t.header {
			frozen = 1
		}
		rows := make([]any, len(t.rows))
		for i, r := range t.rows {
			cells := make([]any, len(r))
			for j, v := range r {
				cells[j] = sheetCell(v)
			}
			rows[i] = map[string]any{"values": cells}
		}
		reqs = append(reqs,
			map[string]any{"updateSheetProperties": map[string]any{
				"properties": map[string]any{"sheetId": id, "gridProperties": map[string]any{
					"rowCount": len(t.rows) + 20, "columnCount": width, "frozenRowCount": frozen}},
				"fields": "gridProperties(rowCount,columnCount,frozenRowCount)"}},
			// A range of just the sheet id covers the whole tab: cells not in rows are cleared.
			map[string]any{"updateCells": map[string]any{"range": map[string]any{"sheetId": id}, "rows": rows, "fields": "userEnteredValue,userEnteredFormat"}},
			map[string]any{"autoResizeDimensions": map[string]any{"dimensions": map[string]any{"sheetId": id, "dimension": "COLUMNS"}}})
		if t.header {
			reqs = append(reqs, map[string]any{"setBasicFilter": map[string]any{"filter": map[string]any{
				"range": map[string]any{"sheetId": id, "startRowIndex": 0, "endRowIndex": len(t.rows)}}}})
		}
	}
	return s.call(ctx, "POST", sheetsAPI+spreadsheet+":batchUpdate", map[string]any{"requests": reqs}, nil)
}

// sheetCell turns a value into a Sheets CellData. Text is always a plain
// string value, so a note starting with "=" never becomes a formula.
func sheetCell(v any) map[string]any {
	num := func(n any, pattern, kind string) map[string]any {
		return map[string]any{"userEnteredValue": map[string]any{"numberValue": n},
			"userEnteredFormat": map[string]any{"numberFormat": map[string]any{"type": kind, "pattern": pattern}}}
	}
	switch v := v.(type) {
	case string:
		if v == "" {
			return map[string]any{}
		}
		return map[string]any{"userEnteredValue": map[string]any{"stringValue": v}}
	case bold:
		return map[string]any{"userEnteredValue": map[string]any{"stringValue": string(v)},
			"userEnteredFormat": map[string]any{"textFormat": map[string]any{"bold": true}}}
	case int:
		return map[string]any{"userEnteredValue": map[string]any{"numberValue": v}}
	case money:
		if v == "" {
			return map[string]any{}
		}
		return num(json.Number(v), "#,##0.00", "NUMBER") // exact decimal text, no float rounding
	case day:
		return num(serialDate(string(v)), "dd mmm yyyy", "DATE")
	case month:
		return num(serialDate(string(v)), "mmm yyyy", "DATE")
	case stamp:
		t := time.Time(v)
		frac := float64(t.Hour()*3600+t.Minute()*60+t.Second()) / 86400
		return num(float64(serialDate(t.Format(time.DateOnly)))+frac, "dd mmm yyyy, h:mm am/pm", "DATE_TIME")
	}
	return map[string]any{"userEnteredValue": map[string]any{"stringValue": fmt.Sprint(v)}}
}

// serialDate is a date's spreadsheet serial number (days since 30 Dec 1899).
func serialDate(date string) int {
	t, _ := time.Parse(time.DateOnly, date)
	return int(t.Sub(time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)).Hours() / 24)
}
