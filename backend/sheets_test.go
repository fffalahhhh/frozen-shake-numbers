package main

import (
	"context"
	"testing"
	"time"
)

func TestSalaryStaff(t *testing.T) {
	names := []string{"Ali", "Alisha", "Rahul"}
	for note, want := range map[string]string{
		"alisha nov": "Alisha", "Ali": "Ali", "Rahul advance": "Rahul",
		"Ali and Rahul": "Unmatched", "": "Unmatched",
	} {
		if got := salaryStaff(note, names); got != want {
			t.Errorf("salaryStaff(%q) = %q, want %q", note, got, want)
		}
	}
}

func TestSheetWorkbook(t *testing.T) {
	a, srv := newTestApp(t)
	c := newClient(t, srv)
	shop, cat, partner := c.signup("sheets@example.com")
	base := "/api/shops/" + shop
	var salaries string
	for _, x := range c.must(200, "GET", base+"/categories", nil)["categories"].([]any) {
		if x.(map[string]any)["name"] == "Salaries" {
			salaries = x.(map[string]any)["id"].(string)
		}
	}
	c.must(201, "POST", base+"/staff", map[string]any{"name": "Ali"})
	c.must(200, "PUT", base+"/revenue/2026-10-02", map[string]any{"cash": "5000", "online": "2500"})
	c.must(200, "PUT", base+"/revenue/2026-11-01", map[string]any{"cash": "1000"})
	c.must(201, "POST", base+"/expenses", map[string]any{"date": "2026-10-02", "amount": "820.50", "categoryId": cat, "note": "=1+1"})
	c.must(201, "POST", base+"/expenses", map[string]any{"date": "2026-10-05", "amount": "3000", "categoryId": salaries, "note": "Ali", "method": "online"})
	c.must(201, "POST", base+"/handovers", map[string]any{"date": "2026-10-03", "amount": "1000", "partnerId": partner})

	tabs, err := a.buildWorkbook(context.Background(), shop, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	get := func(name string) [][]any {
		for _, tb := range tabs {
			if tb.name == name {
				return tb.rows
			}
		}
		t.Fatalf("no tab %q", name)
		return nil
	}
	if tabs[0].name != "Summary" || len(tabs) != 9 {
		t.Fatalf("tabs: %d, first %q", len(tabs), tabs[0].name)
	}
	// Summary: Sales / Expenses / of which salaries / Handed over / Cash in hand.
	sum := get("Summary")
	want := map[string][3]money{
		"Sales":               {"8500.00", "6000.00", "2500.00"},
		"Expenses":            {"3820.50", "820.50", "3000.00"},
		"  of which salaries": {"3000.00", "0.00", "3000.00"},
		"Handed over":         {"1000.00", "1000.00", "0.00"},
	}
	for _, row := range sum[5:9] {
		w := want[row[0].(string)]
		if row[1] != w[0] || row[2] != w[1] || row[3] != w[2] {
			t.Errorf("summary %v, want %v", row, w)
		}
	}
	if r := sum[9]; r[1] != money("3679.50") || r[2] != money("4179.50") || r[3] != money("-500.00") {
		t.Errorf("cash in hand %v", r)
	}
	// Daily: newest first, running balance ends at the all-time cash in hand.
	daily := get("Daily")
	if len(daily) != 5 || daily[1][0] != day("2026-11-01") || daily[1][7] != money("3679.50") || daily[1][8] != "sheets@example.com" || daily[2][1] != money("") {
		t.Errorf("daily %v", daily)
	}
	if e := get("Expenses"); len(e) != 3 || e[2][4] != "=1+1" || e[2][5] != "sheets@example.com" {
		t.Errorf("expenses %v", e)
	}
	if s := get("Salaries"); len(s) != 2 || s[1][1] != "Ali" || s[1][2] != money("3000.00") {
		t.Errorf("salaries %v", s)
	}
	// The formula-looking note must stay a plain string value.
	if v := sheetCell("=1+1")["userEnteredValue"].(map[string]any); v["stringValue"] != "=1+1" {
		t.Errorf("note cell %v", v)
	}
	if serialDate("2026-10-02") != 46297 {
		t.Errorf("serialDate = %d", serialDate("2026-10-02"))
	}
}
