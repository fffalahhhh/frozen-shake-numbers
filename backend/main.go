package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	_ "time/tzdata" // shop timezones must resolve inside slim containers

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type config struct {
	Addr         string
	DatabaseURL  string
	AppURL       string // public URL of the web app, used in reset-password emails
	CookieSecure bool
	SMTPHost     string
	SMTPPort     string
	SMTPUser     string
	SMTPPass     string
	SMTPFrom     string
	StaticDir    string // built PWA to serve alongside the API (single-container deploys)
}

type app struct {
	db  *pgxpool.Pool
	cfg config
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	return config{
		Addr:         env("ADDR", ":"+env("PORT", "8080")), // PORT: set by hosts like Render
		DatabaseURL:  env("DATABASE_URL", "postgres://frozen:frozen@localhost:55433/frozen?sslmode=disable"),
		AppURL:       env("APP_URL", "http://localhost:5173"),
		CookieSecure: env("COOKIE_SECURE", "false") == "true",
		SMTPHost:     os.Getenv("SMTP_HOST"),
		SMTPPort:     env("SMTP_PORT", "587"),
		SMTPUser:     os.Getenv("SMTP_USER"),
		SMTPPass:     os.Getenv("SMTP_PASS"),
		SMTPFrom:     env("SMTP_FROM", "Frozen Shake <no-reply@frozenshake.local>"),
		StaticDir:    os.Getenv("STATIC_DIR"),
	}
}

func main() {
	cfg := loadConfig()
	ctx := context.Background()
	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := migrate(ctx, db); err != nil {
		log.Fatal("migrate: ", err)
	}
	a := &app{db: db, cfg: cfg}
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           a.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	log.Printf("api listening on %s", cfg.Addr)
	log.Fatal(srv.ListenAndServe())
}

// migrate applies migrations/*.sql in name order, once each, under an advisory
// lock so concurrent replicas don't race.
func migrate(ctx context.Context, db *pgxpool.Pool) error {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(727274)`); err != nil {
		return err
	}
	defer conn.Exec(ctx, `SELECT pg_advisory_unlock(727274)`)
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	names, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		var done bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, name).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, _ := migrationsFS.ReadFile(name)
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		log.Printf("applied migration %s", name)
	}
	return nil
}

func (a *app) routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	m.Handle("POST /api/auth/register", h(a.register))
	m.Handle("POST /api/auth/login", h(a.login))
	m.Handle("POST /api/auth/logout", h(a.logout))
	m.Handle("POST /api/auth/forgot-password", h(a.forgotPassword))
	m.Handle("POST /api/auth/reset-password", h(a.resetPassword))
	m.Handle("GET /api/auth/me", a.authed(a.me))

	m.Handle("GET /api/shops", a.authed(a.listShops))
	m.Handle("POST /api/shops", a.authed(a.createShop))
	m.Handle("GET /api/shops/{shopId}", a.shop(roleMember, a.getShop))
	m.Handle("PUT /api/shops/{shopId}", a.shop(roleMember, a.updateShop))
	m.Handle("DELETE /api/shops/{shopId}", a.shop(roleOwner, a.deleteShop))

	m.Handle("GET /api/shops/{shopId}/revenue", a.shop(roleMember, a.listRevenue))
	m.Handle("PUT /api/shops/{shopId}/revenue/{date}", a.shop(roleMember, a.putRevenue))

	m.Handle("GET /api/shops/{shopId}/expenses", a.shop(roleMember, a.listTxns(expenseKind)))
	m.Handle("POST /api/shops/{shopId}/expenses", a.shop(roleMember, a.createTxn(expenseKind)))
	m.Handle("PUT /api/shops/{shopId}/expenses/{id}", a.shop(roleMember, a.updateTxn(expenseKind)))
	m.Handle("DELETE /api/shops/{shopId}/expenses/{id}", a.shop(roleMember, a.deleteTxn(expenseKind)))

	m.Handle("GET /api/shops/{shopId}/categories", a.shop(roleMember, a.listCategories))
	m.Handle("POST /api/shops/{shopId}/categories", a.shop(roleMember, a.createNamed("expense_categories", "Category name")))
	m.Handle("PUT /api/shops/{shopId}/categories/{id}", a.shop(roleMember, a.updateNamed("expense_categories", "Category name")))
	m.Handle("DELETE /api/shops/{shopId}/categories/{id}", a.shop(roleMember, a.deactivateNamed("expense_categories")))

	m.Handle("GET /api/shops/{shopId}/partners", a.shop(roleMember, a.listPartners))
	m.Handle("POST /api/shops/{shopId}/partners", a.shop(roleMember, a.createNamed("partners", "Partner name")))
	m.Handle("PUT /api/shops/{shopId}/partners/{id}", a.shop(roleMember, a.updateNamed("partners", "Partner name")))
	m.Handle("DELETE /api/shops/{shopId}/partners/{id}", a.shop(roleMember, a.deactivateNamed("partners")))

	m.Handle("GET /api/shops/{shopId}/handovers", a.shop(roleMember, a.listTxns(handoverKind)))
	m.Handle("POST /api/shops/{shopId}/handovers", a.shop(roleMember, a.createTxn(handoverKind)))
	m.Handle("PUT /api/shops/{shopId}/handovers/{id}", a.shop(roleMember, a.updateTxn(handoverKind)))
	m.Handle("DELETE /api/shops/{shopId}/handovers/{id}", a.shop(roleMember, a.deleteTxn(handoverKind)))

	m.Handle("GET /api/shops/{shopId}/history", a.shop(roleMember, a.history))

	m.Handle("/api/", h(func(w http.ResponseWriter, r *http.Request) error { return errNotFound }))
	if a.cfg.StaticDir != "" {
		m.Handle("/", spa(a.cfg.StaticDir))
	}
	return logRequests(m)
}

// spa serves the built PWA, mirroring frontend/nginx.conf: unknown paths get
// index.html, hashed assets are cached forever, everything else revalidates.
func spa(dir string) http.Handler {
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "same-origin")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
		p := path.Clean("/" + r.URL.Path)
		if fi, err := os.Stat(filepath.Join(dir, filepath.FromSlash(p))); err != nil || fi.IsDir() {
			r.URL.Path = "/" // SPA route (or a directory): serve index.html
		}
		if strings.HasPrefix(p, "/assets/") {
			hd.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			hd.Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}
