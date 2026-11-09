package main

// Integration tests against a real PostgreSQL. They reset the target
// database's public schema, so point TEST_DATABASE_URL at a throwaway DB:
//
//	TEST_DATABASE_URL=postgres://frozen:frozen@localhost:55433/frozen_test?sslmode=disable go test ./...

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAddMoney(t *testing.T) {
	for _, c := range [][3]string{{"", "0", "0.00"}, {"0.10", "0.20", "0.30"}, {"4000.00", "-1550.50", "2449.50"}} {
		if got := addMoney(c[0], c[1]); got != c[2] {
			t.Errorf("addMoney(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestINR(t *testing.T) {
	for in, want := range map[string]string{"0": "₹0.00", "999.5": "₹999.50", "1000": "₹1,000.00", "123456.78": "₹1,23,456.78", "-12345678": "−₹1,23,45,678.00", "-0.00": "₹0.00"} {
		if got := inr(in); got != want {
			t.Errorf("inr(%q) = %q, want %q", in, got, want)
		}
	}
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if _, err := db.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer((&app{db: db, cfg: config{AppURL: "http://test"}}).routes())
	t.Cleanup(srv.Close)
	return srv
}

type client struct {
	t    *testing.T
	base string
	http *http.Client
}

func newClient(t *testing.T, srv *httptest.Server) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t, srv.URL, &http.Client{Jar: jar}}
}

// do sends a JSON request and decodes the JSON response (if any) into a map.
func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req, _ := http.NewRequest(method, c.base+path, &buf)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (c *client) must(want int, method, path string, body any) map[string]any {
	c.t.Helper()
	got, out := c.do(method, path, body)
	if got != want {
		c.t.Fatalf("%s %s = %d, want %d: %v", method, path, got, want, out)
	}
	return out
}

// signup registers a user with one shop and returns (shopId, firstCategoryId, firstPartnerId).
func (c *client) signup(email string) (string, string, string) {
	c.must(201, "POST", "/api/auth/register", map[string]any{"email": email, "password": "password123", "shopName": "Frozen Shake"})
	shops := c.must(200, "GET", "/api/shops", nil)["shops"].([]any)
	shop := shops[0].(map[string]any)["id"].(string)
	cats := c.must(200, "GET", "/api/shops/"+shop+"/categories", nil)["categories"].([]any)
	parts := c.must(200, "GET", "/api/shops/"+shop+"/partners", nil)["partners"].([]any)
	if len(cats) != 4 || len(parts) != 5 {
		c.t.Fatalf("seed: got %d categories, %d partners", len(cats), len(parts))
	}
	return shop, cats[0].(map[string]any)["id"].(string), parts[0].(map[string]any)["id"].(string)
}

func TestCashInHand(t *testing.T) {
	srv := newTestServer(t)
	c := newClient(t, srv)
	shop, cat, partner := c.signup("cash@example.com")
	base := "/api/shops/" + shop
	day := "2026-10-13"

	c.must(200, "PUT", base+"/revenue/"+day, map[string]any{"amount": "3000"})
	c.must(200, "PUT", base+"/revenue/"+day, map[string]any{"amount": 4000}) // update, not duplicate
	if rev := c.must(200, "GET", base+"/revenue?from="+day+"&to="+day, nil)["revenue"].([]any); len(rev) != 1 || rev[0].(map[string]any)["cash"] != "4000.00" {
		t.Fatalf("want 1 revenue row, all cash ({amount} predates the split), got %v", rev)
	}

	exp := map[string]any{"id": "7f9c2ba4-e88f-4a6b-9b1a-2f1e6d1c0a01", "date": day, "amount": "820.50", "categoryId": cat, "note": "Fruit"}
	c.must(201, "POST", base+"/expenses", exp)
	c.must(200, "POST", base+"/expenses", exp) // offline replay → same row, no duplicate
	c.must(201, "POST", base+"/expenses", map[string]any{"date": day, "amount": "229.50", "categoryId": cat})
	c.must(201, "POST", base+"/handovers", map[string]any{"date": day, "amount": "500", "partnerId": partner})

	// A later day that spends more than it earns: cash in hand carries over.
	// Revenue is split, and the big expense is paid online.
	rv := c.must(200, "PUT", base+"/revenue/2026-10-14", map[string]any{"cash": "600", "online": "400"})["revenue"].(map[string]any)
	if rv["amount"] != "1000.00" || rv["cash"] != "600.00" || rv["online"] != "400.00" {
		t.Fatalf("split revenue = %v", rv)
	}
	if rev := c.must(200, "GET", base+"/revenue?limit=1", nil)["revenue"].([]any); len(rev) != 1 || rev[0].(map[string]any)["date"] != "2026-10-14" {
		t.Fatalf("limit=1 should return only the latest day, got %v", rev)
	}
	c.must(201, "POST", base+"/expenses", map[string]any{"date": "2026-10-14", "amount": "3000", "categoryId": cat, "method": "online"})
	c.must(422, "POST", base+"/expenses", map[string]any{"date": day, "amount": "1", "categoryId": cat, "method": "card"})
	if items := c.must(200, "GET", base+"/expenses?method=online", nil)["items"].([]any); len(items) != 1 || items[0].(map[string]any)["method"] != "online" {
		t.Errorf("online expenses = %v", items)
	}
	// An earlier month, so October opens with a balance.
	c.must(200, "PUT", base+"/revenue/2026-09-30", map[string]any{"amount": "100"})

	h := c.must(200, "GET", base+"/history?from=2026-10-01&to=2026-10-31", nil)
	days := h["days"].([]any)
	if len(days) != 2 {
		t.Fatalf("want 2 history days, got %v", days)
	}
	for i, want := range []map[string]string{
		{"date": "2026-10-14", "revenue": "1000.00", "expenses": "3000.00", "handovers": "0.00", "net": "-2000.00", "balance": "550.00"},
		{"date": day, "revenue": "4000.00", "expenses": "1050.00", "handovers": "500.00", "net": "2450.00", "balance": "2550.00"},
	} {
		d := days[i].(map[string]any)
		for k, v := range want {
			if d[k] != v {
				t.Errorf("history %s %s = %v, want %s", want["date"], k, d[k], v)
			}
		}
	}
	tot := h["totals"].(map[string]any)
	if tot["openingBalance"] != "100.00" || tot["net"] != "450.00" || tot["closingBalance"] != "550.00" {
		t.Errorf("totals = %v", tot)
	}

	// All-time summary: 5100 − 4050 − 500.
	sum := c.must(200, "GET", base+"/summary", nil)
	want := map[string]string{"revenue": "5100.00", "expenses": "4050.00", "handovers": "500.00", "cashInHand": "550.00"}
	for k, v := range want {
		if got := sum["summary"].(map[string]any)[k]; got != v {
			t.Errorf("summary %s = %v, want %s", k, got, v)
		}
	}
	if sum["since"] != "2026-09-30" {
		t.Errorf("since = %v", sum["since"])
	}
	// Per method: cash 4700 − 1050 − 500, online 400 − 3000. They add up to the total.
	if got := sum["cash"].(map[string]any)["cashInHand"]; got != "3150.00" {
		t.Errorf("cash in hand = %v, want 3150.00", got)
	}
	if got := sum["online"].(map[string]any)["cashInHand"]; got != "-2600.00" {
		t.Errorf("online balance = %v, want -2600.00", got)
	}

	// History filtered to online: only the day with online activity.
	oh := c.must(200, "GET", base+"/history?from=2026-10-01&to=2026-10-31&method=online", nil)
	if od := oh["days"].([]any); len(od) != 1 || od[0].(map[string]any)["revenue"] != "400.00" || od[0].(map[string]any)["balance"] != "-2600.00" {
		t.Errorf("online history = %v", od)
	}
	c.must(422, "GET", base+"/history?from=2026-10-01&to=2026-10-31&method=card", nil)

	// Validation: negative / zero / too precise amounts are rejected.
	for _, amt := range []any{"-5", 0, "1.234", "abc"} {
		c.must(422, "POST", base+"/expenses", map[string]any{"date": day, "amount": amt, "categoryId": cat})
	}

	// Renaming or hiding a category keeps the expense's original name.
	c.must(200, "PUT", base+"/categories/"+cat, map[string]any{"name": "Stock & Fruit"})
	c.must(204, "DELETE", base+"/categories/"+cat, nil)
	items := c.must(200, "GET", base+"/expenses?from="+day+"&to="+day, nil)["items"].([]any)
	for _, it := range items {
		if it.(map[string]any)["categoryName"] != "Shop Stock" {
			t.Errorf("snapshot lost: %v", it)
		}
	}
}

func TestTenantIsolation(t *testing.T) {
	srv := newTestServer(t)
	alice, bob := newClient(t, srv), newClient(t, srv)
	aShop, aCat, aPartner := alice.signup("alice@example.com")
	bShop, _, _ := bob.signup("bob@example.com")
	day := "2026-10-13"
	expID := "11111111-2222-4333-8444-555555555555"
	alice.must(201, "POST", "/api/shops/"+aShop+"/expenses", map[string]any{"id": expID, "date": day, "amount": "100", "categoryId": aCat})
	alice.must(200, "PUT", "/api/shops/"+aShop+"/revenue/"+day, map[string]any{"amount": "900"})

	a := "/api/shops/" + aShop
	for _, req := range [][2]string{
		{"GET", a}, {"PUT", a}, {"DELETE", a},
		{"GET", a + "/expenses"}, {"GET", a + "/revenue"}, {"PUT", a + "/revenue/" + day},
		{"GET", a + "/history?from=2026-10-01&to=2026-10-31"}, {"GET", a + "/summary"}, {"GET", a + "/export.pdf?to=2026-10-31"}, {"GET", a + "/categories"}, {"GET", a + "/partners"},
		{"PUT", a + "/expenses/" + expID}, {"DELETE", a + "/expenses/" + expID},
		{"POST", a + "/handovers"}, {"PUT", a + "/categories/" + aCat}, {"DELETE", a + "/partners/" + aPartner},
	} {
		bob.must(404, req[0], req[1], map[string]any{"amount": "1", "name": "x"})
	}

	b := "/api/shops/" + bShop
	// Bob can't reach Alice's rows through his own shop either.
	bob.must(404, "PUT", b+"/categories/"+aCat, map[string]any{"name": "pwned"})
	bob.must(204, "DELETE", b+"/expenses/"+expID, nil) // idempotent no-op on his shop
	bob.must(422, "POST", b+"/expenses", map[string]any{"date": day, "amount": "5", "categoryId": aCat})
	bob.must(422, "POST", b+"/handovers", map[string]any{"date": day, "amount": "5", "partnerId": aPartner})
	bCats := bob.must(200, "GET", b+"/categories", nil)["categories"].([]any)
	bCat := bCats[0].(map[string]any)["id"].(string)
	bob.must(409, "POST", b+"/expenses", map[string]any{"id": expID, "date": day, "amount": "5", "categoryId": bCat})
	if n := len(bob.must(200, "GET", b+"/expenses", nil)["items"].([]any)); n != 0 {
		t.Errorf("bob sees %d expenses in his shop, want 0", n)
	}

	// Alice's data is untouched.
	items := alice.must(200, "GET", a+"/expenses", nil)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["amount"] != "100.00" {
		t.Errorf("alice's expenses changed: %v", items)
	}
	if n := len(bob.must(200, "GET", "/api/shops", nil)["shops"].([]any)); n != 1 {
		t.Errorf("bob lists %d shops, want 1", n)
	}

	// Signed-out requests are rejected.
	anon := newClient(t, srv)
	anon.must(401, "GET", a+"/expenses", nil)
	anon.must(401, "GET", "/api/shops", nil)
	alice.must(204, "POST", "/api/auth/logout", nil)
	alice.must(401, "GET", "/api/auth/me", nil)
	anon.must(401, "POST", "/api/auth/login", map[string]any{"email": "alice@example.com", "password": "wrong-password"})
	alice.must(200, "POST", "/api/auth/login", map[string]any{"email": "ALICE@example.com", "password": "password123"})
}

func TestDuesAndLeaves(t *testing.T) {
	srv := newTestServer(t)
	c := newClient(t, srv)
	shop, cat, _ := c.signup("dues@example.com")
	base := "/api/shops/" + shop

	c.must(204, "PUT", base+"/categories/"+cat+"/due", map[string]any{"amount": "15000", "day": 5})
	c.must(422, "PUT", base+"/categories/"+cat+"/due", map[string]any{"amount": "15000", "day": 32})
	got := c.must(200, "GET", base+"/categories", nil)["categories"].([]any)[0].(map[string]any)
	if got["dueAmount"] != "15000.00" || got["dueDay"] != float64(5) {
		t.Errorf("due not saved: %v", got)
	}
	c.must(204, "PUT", base+"/categories/"+cat+"/due", map[string]any{"amount": nil})
	if got := c.must(200, "GET", base+"/categories", nil)["categories"].([]any)[0].(map[string]any); got["dueDay"] != nil {
		t.Errorf("due not cleared: %v", got)
	}

	staff := c.must(201, "POST", base+"/staff", map[string]any{"name": "Ravi"})["id"].(string)
	c.must(204, "PUT", base+"/staff/"+staff+"/salary", map[string]any{"amount": "12000", "day": 1})
	if got := c.must(200, "GET", base+"/staff", nil)["staff"].([]any)[0].(map[string]any); got["dueAmount"] != "12000.00" || got["dueDay"] != float64(1) {
		t.Errorf("salary not saved: %v", got)
	}
	c.must(204, "PUT", base+"/staff/"+staff+"/leaves/2026-10-20", map[string]any{"note": "Sick"})
	c.must(204, "PUT", base+"/staff/"+staff+"/leaves/2026-10-20", map[string]any{}) // retry: no duplicate
	c.must(204, "PUT", base+"/staff/"+staff+"/leaves/2026-11-02", map[string]any{})
	if l := c.must(200, "GET", base+"/leaves?from=2026-10-01&to=2026-10-31", nil)["leaves"].([]any); len(l) != 1 {
		t.Errorf("want 1 October leave, got %v", l)
	}
	c.must(204, "DELETE", base+"/staff/"+staff+"/leaves/2026-10-20", nil)
	if l := c.must(200, "GET", base+"/leaves", nil)["leaves"].([]any); len(l) != 1 {
		t.Errorf("want 1 leave left, got %v", l)
	}

	// Another shop can't touch this staff member.
	bob := newClient(t, srv)
	bShop, _, _ := bob.signup("bob-staff@example.com")
	bob.must(404, "PUT", "/api/shops/"+bShop+"/staff/"+staff+"/leaves/2026-10-21", map[string]any{})
	bob.must(404, "PUT", "/api/shops/"+bShop+"/categories/"+cat+"/due", map[string]any{"amount": "1", "day": 1})
	bob.must(404, "PUT", "/api/shops/"+bShop+"/staff/"+staff+"/salary", map[string]any{"amount": "1", "day": 1})
}

func TestExportPDF(t *testing.T) {
	srv := newTestServer(t)
	c := newClient(t, srv)
	shop, cat, partner := c.signup("export@example.com")
	base := "/api/shops/" + shop
	c.must(200, "PUT", base+"/revenue/2026-10-02", map[string]any{"cash": "5000", "online": "2500"})
	c.must(201, "POST", base+"/expenses", map[string]any{"date": "2026-10-02", "amount": "820.50", "categoryId": cat, "note": "Milk"})
	c.must(201, "POST", base+"/handovers", map[string]any{"date": "2026-10-03", "amount": "1000", "partnerId": partner, "method": "online"})

	for _, q := range []string{"from=2026-10-01&to=2026-10-31&items=1", "to=2026-10-31&method=cash&sections=expenses,days"} {
		res, err := c.http.Get(c.base + base + "/export.pdf?" + q)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/pdf" || !bytes.HasPrefix(body, []byte("%PDF")) {
			t.Fatalf("%s: got %d %s %.80q", q, res.StatusCode, res.Header.Get("Content-Type"), body)
		}
		if q[0] == 'f' && !strings.Contains(res.Header.Get("Content-Disposition"), "Frozen-Shake_Statement_2026-10.pdf") {
			t.Errorf("filename: %s", res.Header.Get("Content-Disposition"))
		}
	}
	c.must(422, "GET", base+"/export.pdf?to=2026-10-31&sections=staff", nil)
	c.must(422, "GET", base+"/export.pdf?from=2026-10-31&to=2026-10-01", nil)
}
