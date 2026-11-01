package main

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"mime"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-pdf/fpdf"
	"github.com/jackc/pgx/v5"
)

// ---------- PDF statement ----------
// One shop, one period, A4. Rows never split across pages, a heading is never
// left alone at the bottom of a page, and a table that runs onto a new page
// repeats its headings there.

//go:embed fonts/Inter-Regular.ttf
var interRegular []byte

//go:embed fonts/Inter-SemiBold.ttf
var interSemiBold []byte

var exportSections = []string{"expenses", "handovers", "revenue", "days"}

type exportEntry struct {
	Group, Date, Amount, Method, Note, GroupTotal string
	GroupCount                                    int
	Share                                         string // % of the section total
}

type exportRevenue struct{ Date, Cash, Online, Amount string }

type statement struct {
	shop, address, period, periodSub, payments, generated string
	method                                                *string
	from, to                                              string
	items                                                 bool
	sections                                              map[string]bool
	days                                                  []dayRow // oldest first
	byMonth                                               bool
	opening, revenue, expenses, handovers, net            string
	revenueRows                                           []exportRevenue
	expenseRows, handoverRows                             []exportEntry
}

// exportPDF: GET /shops/{id}/export.pdf?from=&to=&method=&sections=&items=1
// No `from` means all time.
func (a *app) exportPDF(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	q := r.URL.Query()
	allTime := q.Get("from") == ""
	from := "2000-01-01"
	if !allTime {
		var err error
		if from, err = parseDate(q.Get("from")); err != nil {
			return invalid("from: Date must be YYYY-MM-DD")
		}
	}
	to, err := parseDate(q.Get("to"))
	if err != nil {
		return invalid("to: Date must be YYYY-MM-DD")
	}
	if to < from {
		return invalid("The end date is before the start date")
	}
	method, err := optMethod(r)
	if err != nil {
		return err
	}
	st := statement{method: method, from: from, to: to, items: q.Get("items") == "1", sections: map[string]bool{}}
	for _, s := range strings.Split(q.Get("sections"), ",") {
		if s == "" {
			continue
		}
		if !slices.Contains(exportSections, s) {
			return invalid("Unknown section %q", s)
		}
		st.sections[s] = true
	}
	if len(st.sections) == 0 {
		for _, s := range exportSections {
			st.sections[s] = true
		}
	}

	ctx := r.Context()
	var tz string
	if err := a.db.QueryRow(ctx, `SELECT name, address, timezone FROM shops WHERE id = $1`, sc.ID).Scan(&st.shop, &st.address, &tz); err != nil {
		return err
	}
	days, opening, err := a.historyDays(ctx, sc.ID, from, to, method)
	if err != nil {
		return err
	}
	slices.Reverse(days)
	st.days, st.opening = days, addMoney(opening, "0")
	for _, d := range days {
		st.revenue, st.expenses, st.handovers, st.net = addMoney(st.revenue, d.Revenue), addMoney(st.expenses, d.Expenses), addMoney(st.handovers, d.Handovers), addMoney(st.net, d.Net)
	}
	st.revenue, st.expenses, st.handovers, st.net = addMoney(st.revenue, "0"), addMoney(st.expenses, "0"), addMoney(st.handovers, "0"), addMoney(st.net, "0")

	rows, err := a.db.Query(ctx, `
		SELECT business_date::text, cash::text, online::text, amount::text FROM daily_revenues
		WHERE shop_id = $1 AND business_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR `+revenueCol(4)+` > 0)
		ORDER BY business_date`, sc.ID, from, to, method)
	if err != nil {
		return err
	}
	if st.revenueRows, err = pgx.CollectRows(rows, pgx.RowToStructByPos[exportRevenue]); err != nil {
		return err
	}
	if st.sections["expenses"] {
		if st.expenseRows, err = a.exportEntries(ctx, expenseKind, sc.ID, from, to, method); err != nil {
			return err
		}
	}
	if st.sections["handovers"] {
		if st.handoverRows, err = a.exportEntries(ctx, handoverKind, sc.ID, from, to, method); err != nil {
			return err
		}
	}

	// Labels
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	st.generated = time.Now().In(loc).Format("2 Jan 2006, 3:04 pm")
	st.payments = map[string]string{"": "Cash and online", "cash": "Cash only", "online": "Online only"}[deref(method)]
	file := from + "_to_" + to
	first, last := monthOf(from)
	switch {
	case allTime:
		st.period, file = "All time", "all-time"
		if len(days) > 0 {
			st.periodSub = fmtDate(days[0].Date, "2 Jan 2006") + " – " + fmtDate(to, "2 Jan 2006")
		}
	case from == first && to == last:
		st.period, file = fmtDate(from, "January 2006"), from[:7]
	default:
		st.period = fmtDate(from, "2 Jan 2006") + " – " + fmtDate(to, "2 Jan 2006")
	}
	st.byMonth = allTime || daysBetween(from, to) > 62

	var buf bytes.Buffer
	if err := st.render(&buf); err != nil {
		return err
	}
	name := strings.Join(strings.FieldsFunc(st.shop, func(c rune) bool { return c == '/' || c == '\\' || c == '"' || c == ' ' }), "-")
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name + "_Statement_" + file + ".pdf"}))
	w.Header().Set("Cache-Control", "no-store")
	_, err = w.Write(buf.Bytes())
	return err
}

// exportEntries lists expenses (or handovers) grouped by their current
// category (or partner) name, biggest group first, oldest entry first.
func (a *app) exportEntries(ctx context.Context, k txnKind, shopID, from, to string, method *string) ([]exportEntry, error) {
	rows, err := a.db.Query(ctx, `
		SELECT g.name, t.business_date::text, t.amount::text, t.method, t.note,
			(sum(t.amount) OVER grp)::text, count(*) OVER grp,
			round(100 * sum(t.amount) OVER grp / sum(t.amount) OVER (), 1)::text
		FROM `+k.table+` t JOIN `+k.refTable+` g ON g.shop_id = t.shop_id AND g.id = t.`+k.ref+`_id
		WHERE t.shop_id = $1 AND t.business_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR t.method = $4)
		WINDOW grp AS (PARTITION BY t.`+k.ref+`_id)
		ORDER BY sum(t.amount) OVER grp DESC, g.name, t.business_date, t.created_at`, shopID, from, to, method)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[exportEntry])
}

// ---------- Layout ----------

const (
	pageW, pageH = 210.0, 297.0
	margin       = 15.0
	contentW     = pageW - 2*margin
	bottom       = pageH - 18 // content stops here; the footer sits below
	lineH, padY  = 4.4, 1.5
	padX         = 2.0
)

type rgb [3]int

// Colours from the app's design tokens (frontend/src/styles.css).
var (
	cInk   = rgb{23, 37, 27}
	cMuted = rgb{113, 128, 113}
	cBrand = rgb{49, 91, 62}
	cRed   = rgb{196, 86, 66}
	cSoft  = rgb{234, 240, 229}
	cZebra = rgb{247, 248, 244}
	cRule  = rgb{221, 228, 217}
	cWhite = rgb{255, 255, 255}
)

type col struct {
	w     float64
	align string // L, R, or W (left, wrapping onto more lines)
}

type doc struct {
	*fpdf.Fpdf
	cont func() // repeats the current table's headings after a page break
}

func (d *doc) ink(c rgb)  { d.SetTextColor(c[0], c[1], c[2]) }
func (d *doc) fill(c rgb) { d.SetFillColor(c[0], c[1], c[2]) }
func (d *doc) line(c rgb) { d.SetDrawColor(c[0], c[1], c[2]) }
func (d *doc) font(bold bool, size float64) {
	if bold {
		d.SetFont("Inter", "B", size)
	} else {
		d.SetFont("Inter", "", size)
	}
}

// text writes one line of text at (x, y) within width w.
func (d *doc) text(x, y, w, h float64, s, align string) {
	d.SetXY(x, y)
	d.CellFormat(w, h, s, "", 0, align, false, 0, "")
}

// need starts a new page, repeating the current headings, unless h mm still fit.
func (d *doc) need(h float64) {
	if d.GetY()+h > bottom {
		d.AddPage()
		if d.cont != nil {
			d.cont()
		}
	}
}

// row draws one table row; amounts starting with "−" are red.
func (d *doc) row(cols []col, shade bool, cells ...string) {
	lines := make([][]string, len(cols))
	n := 1
	for i, c := range cols {
		lines[i] = []string{cells[i]}
		if c.align == "W" {
			if lines[i] = d.SplitText(cells[i], c.w-2*padX+2*d.GetCellMargin()); len(lines[i]) == 0 {
				lines[i] = []string{""}
			}
			n = max(n, len(lines[i]))
		}
	}
	h := float64(n)*lineH + 2*padY
	d.need(h)
	x, y := margin, d.GetY()
	if shade {
		d.fill(cZebra)
		d.Rect(margin, y, contentW, h, "F")
	}
	for i, c := range cols {
		align := strings.TrimSuffix(c.align, "W")
		if align == "" {
			align = "L"
		}
		d.ink(cInk)
		if strings.HasPrefix(cells[i], "−") {
			d.ink(cRed)
		}
		for j, s := range lines[i] {
			d.text(x+padX, y+padY+float64(j)*lineH, c.w-2*padX, lineH, s, align)
		}
		x += c.w
	}
	d.SetXY(margin, y+h)
}

// head draws a table's column headings.
func (d *doc) head(cols []col, labels ...string) {
	y := d.GetY()
	d.font(true, 7)
	d.ink(cMuted)
	x := margin
	for i, c := range cols {
		align := strings.TrimSuffix(c.align, "W")
		if align == "" {
			align = "L"
		}
		d.text(x+padX, y, c.w-2*padX, 6, strings.ToUpper(labels[i]), align)
		x += c.w
	}
	d.line(cRule)
	d.SetLineWidth(0.2)
	d.Line(margin, y+6, margin+contentW, y+6)
	d.SetXY(margin, y+6.5)
	d.font(false, 8.5)
}

// section draws a section title with its total, e.g. "Expenses by category   ₹88,150.00".
func (d *doc) section(title, total string) {
	y := d.GetY() + 5
	d.font(true, 11)
	d.ink(cBrand)
	d.text(margin, y, contentW*0.65, 7, title, "L")
	d.text(margin+contentW*0.35, y, contentW*0.65, 7, total, "R")
	d.line(cBrand)
	d.SetLineWidth(0.5)
	d.Line(margin, y+8, margin+contentW, y+8)
	d.SetXY(margin, y+10)
}

// band is a group heading inside a section: name on the left, total on the right.
func (d *doc) band(name, total string) {
	y := d.GetY() + 1
	d.fill(cSoft)
	d.RoundedRect(margin, y, contentW, 7.5, 1.5, "1234", "F")
	d.font(true, 9.5)
	d.ink(cInk)
	d.text(margin+padX, y, contentW*0.7, 7.5, name, "L")
	d.text(margin+contentW*0.3, y, contentW*0.7-padX, 7.5, total, "R")
	d.SetXY(margin, y+8.5)
	d.font(false, 8.5)
}

// totalRow is the bold closing row of a table, with a rule above.
func (d *doc) totalRow(cols []col, cells ...string) {
	d.need(lineH + 2*padY + 1)
	d.line(cInk)
	d.SetLineWidth(0.3)
	d.Line(margin, d.GetY(), margin+contentW, d.GetY())
	d.font(true, 8.5)
	d.row(cols, false, cells...)
	d.font(false, 8.5)
}

func (d *doc) empty(text string) {
	d.font(false, 8.5)
	d.ink(cMuted)
	d.text(margin, d.GetY()+1, contentW, 7, text, "L")
	d.SetXY(margin, d.GetY()+8)
}

// render lays the statement out twice: the first pass counts the pages so
// the footer can say "Page 2 of 5".
func (st *statement) render(out *bytes.Buffer) error {
	pages := 0
	for pass := 0; pass < 2; pass++ {
		d := st.layout(pages)
		if err := d.Error(); err != nil {
			return err
		}
		pages = d.PageNo()
		if pass == 1 {
			return d.Output(out)
		}
	}
	return nil
}

func (st *statement) layout(pages int) *doc {
	d := &doc{Fpdf: fpdf.New("P", "mm", "A4", "")}
	d.AddUTF8FontFromBytes("Inter", "", interRegular)
	d.AddUTF8FontFromBytes("Inter", "B", interSemiBold)
	d.SetMargins(margin, margin, margin)
	d.SetAutoPageBreak(true, pageH-bottom) // a safety net; need() breaks first
	d.SetTitle(st.shop+" statement · "+st.period, true)
	d.SetCreator("Frozen Shake Cash Tracker", true)
	d.SetHeaderFunc(func() {
		if d.PageNo() == 1 {
			return
		}
		d.font(false, 7.5)
		d.ink(cMuted)
		d.text(margin, 9, contentW/2, 5, st.shop+" · "+st.period, "L")
		d.text(margin+contentW/2, 9, contentW/2, 5, "Statement", "R")
		d.line(cRule)
		d.SetLineWidth(0.2)
		d.Line(margin, 15, margin+contentW, 15)
		d.SetXY(margin, 18)
	})
	d.SetFooterFunc(func() {
		d.font(false, 7.5)
		d.ink(cMuted)
		d.text(margin, pageH-13, contentW/2, 5, "Generated "+st.generated, "L")
		d.text(margin+contentW/2, pageH-13, contentW/2, 5, fmt.Sprintf("Page %d of %d", d.PageNo(), max(pages, d.PageNo())), "R")
	})
	d.AddPage()
	st.cover(d)
	if st.sections["expenses"] {
		st.grouped(d, "Expenses by category", "Category", st.expenses, st.expenseRows, "No expenses in this period.")
	}
	if st.sections["handovers"] {
		st.grouped(d, "Handovers by partner", "Partner", st.handovers, st.handoverRows, "No handovers in this period.")
	}
	if st.sections["revenue"] {
		st.revenueTable(d)
	}
	if st.sections["days"] {
		st.dayTable(d)
	}
	return d
}

// cover: shop, period and the summary card at the top of page 1.
func (st *statement) cover(d *doc) {
	half, left := contentW/2, contentW*0.6
	size := 18.0
	for d.font(true, size); size > 11 && d.GetStringWidth(st.shop) > left; size-- { // long names shrink to fit
		d.font(true, size-1)
	}
	d.ink(cInk)
	d.text(margin, 15, left, 9, st.shop, "L")
	d.font(false, 8.5)
	d.ink(cMuted)
	for i, s := range d.SplitText(st.address, left) {
		if i < 2 {
			d.text(margin, 24+float64(i)*4, left, 5, s, "L")
		}
	}
	d.text(margin+half, 15, half, 5, "STATEMENT", "R")
	d.font(true, 13)
	d.ink(cInk)
	d.text(margin+half, 20, half, 7, st.period, "R")
	d.font(false, 8.5)
	d.ink(cMuted)
	sub := st.payments
	if st.periodSub != "" {
		sub = st.periodSub + " · " + sub
	}
	d.text(margin+half, 27, half, 5, sub, "R")

	// Summary card: four figures, then the net and closing balance on a brand strip.
	y := 38.0
	cardH := 22.0
	var cash, online string
	for _, r := range st.revenueRows {
		cash, online = addMoney(cash, r.Cash), addMoney(online, r.Online)
	}
	if st.method == nil {
		cardH = 27
	}
	d.fill(cSoft)
	d.RoundedRect(margin, y, contentW, cardH+14, 3, "1234", "F")
	figures := [][2]string{{"Opening balance", st.opening}, {"Revenue", st.revenue}, {"Expenses", st.expenses}, {"Handed over", st.handovers}}
	cw := contentW / 4
	for i, f := range figures {
		x := margin + float64(i)*cw + 5
		d.font(false, 7.5)
		d.ink(cMuted)
		d.text(x, y+5, cw-6, 4, f[0], "L")
		d.font(true, 12.5)
		d.ink(cInk)
		if strings.HasPrefix(inr(f[1]), "−") {
			d.ink(cRed)
		}
		d.text(x, y+10, cw-6, 6, inr(f[1]), "L")
		if i == 1 && st.method == nil {
			d.font(false, 7.5)
			d.ink(cMuted)
			d.text(x, y+17, cw-6, 4, "Cash "+inr(cash), "L")
			d.text(x, y+21, cw-6, 4, "Online "+inr(online), "L")
		}
	}
	sy := y + cardH
	d.fill(cBrand)
	d.RoundedRect(margin, sy, contentW, 14, 3, "34", "F")
	d.ink(cWhite)
	d.font(false, 8.5)
	d.text(margin+5, sy, 60, 14, "Net for the period", "L")
	d.font(true, 10.5)
	d.text(margin+38, sy, 50, 14, inr(st.net), "L")
	d.font(false, 8.5)
	d.text(margin+half, sy, half-60, 14, map[string]string{"": "Closing balance", "cash": "Cash in hand at end", "online": "Online balance at end"}[deref(st.method)], "R")
	d.font(true, 14)
	d.text(margin+contentW-60, sy, 55, 14, inr(addMoney(st.opening, st.net)), "R")
	d.SetXY(margin, sy+18)
}

// grouped: a section of expenses by category or handovers by partner. Each
// group heading carries its total; entries are listed under it when st.items.
func (st *statement) grouped(d *doc, title, groupLabel, total string, rows []exportEntry, none string) {
	d.cont = nil
	d.need(10 + 7 + 9 + 2*(lineH+2*padY))
	d.section(title, inr(total))
	if len(rows) == 0 {
		d.empty(none)
		return
	}
	if !st.items {
		cols := []col{{95, "W"}, {25, "R"}, {25, "R"}, {35, "R"}}
		heading := func() { d.head(cols, groupLabel, "Entries", "Share", "Amount") }
		d.cont = func() { d.section(title+" (continued)", ""); heading() }
		heading()
		i := 0
		for j, e := range rows {
			if j > 0 && rows[j-1].Group == e.Group {
				continue
			}
			d.row(cols, i%2 == 1, e.Group, fmt.Sprint(e.GroupCount), e.Share+"%", inr(e.GroupTotal))
			i++
		}
		d.cont = nil
		d.totalRow(cols, "Total", fmt.Sprint(len(rows)), "100%", inr(total))
		return
	}
	cols := []col{{24, "L"}, {96, "W"}, {25, "L"}, {35, "R"}}
	heading := func() { d.head(cols, "Date", "Details", "Paid", "Amount") }
	if st.method != nil { // every row would say the same: drop the Paid column
		cols = []col{{24, "L"}, {121, "W"}, {35, "R"}}
		heading = func() { d.head(cols, "Date", "Details", "Amount") }
	}
	heading()
	var cur exportEntry
	shade := false
	for i, e := range rows {
		if i == 0 || rows[i-1].Group != e.Group {
			cur = e
			d.cont = func() { d.section(title+" (continued)", ""); heading() }
			d.need(8.5 + 2*(lineH+2*padY)) // keep the heading with its first rows
			d.band(fmt.Sprintf("%s  ·  %d %s", e.Group, e.GroupCount, plural(e.GroupCount, "entry", "entries")), inr(e.GroupTotal))
			d.cont = func() {
				d.section(title+" (continued)", "")
				heading()
				d.band(cur.Group+" (continued)", inr(cur.GroupTotal))
			}
			shade = false
		}
		note := e.Note
		if note == "" {
			note = "—"
		}
		if st.method != nil {
			d.row(cols, shade, st.day(e.Date), note, inr(e.Amount))
		} else {
			d.row(cols, shade, st.day(e.Date), note, titleCase(e.Method), inr(e.Amount))
		}
		shade = !shade
	}
	d.cont = nil
}

// revenueTable: each day's cash and online takings (per month for long periods).
func (st *statement) revenueTable(d *doc) {
	d.cont = nil
	d.need(10 + 7 + 3*(lineH+2*padY))
	d.section("Revenue", inr(st.revenue))
	rows := st.revenueRows
	if st.byMonth {
		rows = nil
		for _, r := range st.revenueRows {
			if n := len(rows); n > 0 && rows[n-1].Date[:7] == r.Date[:7] {
				m := &rows[n-1]
				m.Cash, m.Online, m.Amount = addMoney(m.Cash, r.Cash), addMoney(m.Online, r.Online), addMoney(m.Amount, r.Amount)
			} else {
				rows = append(rows, r)
			}
		}
	}
	if len(rows) == 0 {
		d.empty("No revenue in this period.")
		return
	}
	first := "Date"
	if st.byMonth {
		first = "Month"
	}
	cols := []col{{45, "L"}, {45, "R"}, {45, "R"}, {45, "R"}}
	labels := []string{first, "Cash", "Online", "Total"}
	if st.method != nil {
		cols, labels = []col{{90, "L"}, {90, "R"}}, []string{first, titleCase(*st.method)}
	}
	d.cont = func() { d.section("Revenue (continued)", ""); d.head(cols, labels...) }
	d.head(cols, labels...)
	var cash, online string
	for i, r := range rows {
		cash, online = addMoney(cash, r.Cash), addMoney(online, r.Online)
		if st.method != nil {
			d.row(cols, i%2 == 1, st.label(r.Date), inr(map[string]string{"cash": r.Cash, "online": r.Online}[*st.method]))
		} else {
			d.row(cols, i%2 == 1, st.label(r.Date), inrOrDash(r.Cash), inrOrDash(r.Online), inr(r.Amount))
		}
	}
	d.cont = nil
	if st.method != nil {
		d.totalRow(cols, "Total", inr(st.revenue))
	} else {
		d.totalRow(cols, "Total", inr(cash), inr(online), inr(st.revenue))
	}
}

// dayTable: one row per day (per month for long periods) with the running balance.
func (st *statement) dayTable(d *doc) {
	title, first := "Daily totals", "Date"
	rows := st.days
	if st.byMonth {
		title, first = "Monthly totals", "Month"
		rows = nil
		for _, r := range st.days {
			if n := len(rows); n > 0 && rows[n-1].Date[:7] == r.Date[:7] {
				m := &rows[n-1]
				m.Revenue, m.Expenses, m.Handovers, m.Net = addMoney(m.Revenue, r.Revenue), addMoney(m.Expenses, r.Expenses), addMoney(m.Handovers, r.Handovers), addMoney(m.Net, r.Net)
				m.Balance = r.Balance
			} else {
				rows = append(rows, r)
			}
		}
	}
	d.cont = nil
	d.need(10 + 7 + 3*(lineH+2*padY))
	d.section(title, "")
	if len(rows) == 0 {
		d.empty("Nothing recorded in this period.")
		return
	}
	cols := []col{{30, "L"}, {30, "R"}, {30, "R"}, {30, "R"}, {30, "R"}, {30, "R"}}
	labels := []string{first, "Revenue", "Expenses", "Handed over", "Net", "In hand"}
	d.cont = func() { d.section(title+" (continued)", ""); d.head(cols, labels...) }
	d.head(cols, labels...)
	d.row(cols, false, "Opening balance", "", "", "", "", inr(st.opening))
	for i, r := range rows {
		d.row(cols, i%2 == 0, st.label(r.Date), inrOrDash(r.Revenue), inrOrDash(r.Expenses), inrOrDash(r.Handovers), inr(r.Net), inr(r.Balance))
	}
	d.cont = nil
	d.totalRow(cols, "Total", inr(st.revenue), inr(st.expenses), inr(st.handovers), inr(st.net), inr(addMoney(st.opening, st.net)))
}

// day shows "02 Oct", adding the year when the period spans more than one.
func (st *statement) day(date string) string {
	if st.from[:4] == st.to[:4] {
		return fmtDate(date, "02 Jan")
	}
	return fmtDate(date, "02 Jan 2006")
}

// label is a table's first column: the day, or the month for long periods.
func (st *statement) label(date string) string {
	if st.byMonth {
		return fmtDate(date, "Jan 2006")
	}
	return st.day(date)
}

// ---------- Formatting ----------

// inr formats a decimal string the Indian way: "-123456.5" → "−₹1,23,456.50".
func inr(s string) string {
	s = addMoney(s, "0")
	neg := strings.HasPrefix(s, "-")
	whole, frac, _ := strings.Cut(strings.TrimPrefix(s, "-"), ".")
	grouped := ""
	if n := len(whole); n > 3 {
		grouped, whole = ","+whole[n-3:], whole[:n-3]
		for len(whole) > 2 {
			grouped, whole = ","+whole[len(whole)-2:]+grouped, whole[:len(whole)-2]
		}
	}
	out := "₹" + whole + grouped + "." + frac
	if neg {
		out = "−" + out
	}
	return out
}

// inrOrDash keeps busy tables readable: zero shows as "—".
func inrOrDash(s string) string {
	if out := inr(s); out != "₹0.00" {
		return out
	}
	return "—"
}

func fmtDate(date, layout string) string {
	t, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return date
	}
	return t.Format(layout)
}

// monthOf returns the first and last day of the month containing date.
func monthOf(date string) (string, string) {
	t, _ := time.Parse(time.DateOnly, date)
	first := t.AddDate(0, 0, 1-t.Day())
	return first.Format(time.DateOnly), first.AddDate(0, 1, -1).Format(time.DateOnly)
}

func daysBetween(from, to string) int {
	a, _ := time.Parse(time.DateOnly, from)
	b, _ := time.Parse(time.DateOnly, to)
	return int(b.Sub(a).Hours() / 24)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
