package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
)

// apiError is rendered as {"error": {"code": ..., "message": ...}}.
type apiError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return e.Message }

var (
	errNotFound     = &apiError{http.StatusNotFound, "not_found", "Not found"}
	errUnauthorized = &apiError{http.StatusUnauthorized, "unauthorized", "Please sign in"}
	errForbidden    = &apiError{http.StatusForbidden, "forbidden", "You don't have permission to do that"}
)

func invalid(format string, args ...any) error {
	return &apiError{http.StatusUnprocessableEntity, "validation", fmt.Sprintf(format, args...)}
}

func conflict(msg string) error {
	return &apiError{http.StatusConflict, "conflict", msg}
}

// h adapts an error-returning handler, so handlers can just `return err`.
func h(fn func(http.ResponseWriter, *http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			writeError(w, r, err)
		}
	})
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	var pg *pgconn.PgError
	switch {
	case errors.As(err, &ae):
	case errors.As(err, &pg) && pg.Code == "23505": // unique_violation
		ae = &apiError{http.StatusConflict, "conflict", "That name is already in use"}
	default:
		log.Printf("ERROR %s %s: %v", r.Method, r.URL.Path, err)
		ae = &apiError{http.StatusInternalServerError, "internal", "Something went wrong"}
	}
	writeJSON(w, ae.Status, map[string]any{"error": ae})
}

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(v)
}

func decode(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		var ae *apiError
		if errors.As(err, &ae) {
			return ae
		}
		return invalid("Invalid JSON body")
	}
	return nil
}

// Money is a non-negative decimal with at most 2 places, kept as a string so
// it goes to PostgreSQL NUMERIC without ever touching float64.
type Money string

var moneyRe = regexp.MustCompile(`^\d{1,10}(\.\d{1,2})?$`)

func (m *Money) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if !moneyRe.MatchString(s) {
		return invalid("Amount must be a number (0 or more) with at most 2 decimals")
	}
	*m = Money(s)
	return nil
}

func (m Money) IsZero() bool { return strings.Trim(string(m), "0.") == "" }

// parseDate accepts a calendar date (YYYY-MM-DD). Dates are business dates in
// the shop's timezone, never converted through UTC.
func parseDate(s string) (string, error) {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil || t.Year() < 2000 || t.Year() > 2100 {
		return "", invalid("Date must be YYYY-MM-DD")
	}
	return s, nil
}

// optDate parses an optional ?from= / ?to= query param; nil means unbounded.
func optDate(r *http.Request, key string) (*string, error) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return nil, nil
	}
	d, err := parseDate(v)
	return &d, err
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func isUUID(s string) bool { return uuidRe.MatchString(s) }

// pathID returns a validated UUID path segment; malformed ids are a 404.
func pathID(r *http.Request, key string) (string, error) {
	id := r.PathValue(key)
	if !isUUID(id) {
		return "", errNotFound
	}
	return id, nil
}

func cleanName(s, field string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || utf8.RuneCountInString(s) > 60 {
		return "", invalid("%s must be 1–60 characters", field)
	}
	return s, nil
}

func cleanNote(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > 500 {
		return "", invalid("Note must be at most 500 characters")
	}
	return s, nil
}
