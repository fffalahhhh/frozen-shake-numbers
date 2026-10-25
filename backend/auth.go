package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/mail"
	"net/smtp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookie = "fs_session"
	sessionTTL    = 30 * 24 * time.Hour
	resetTTL      = time.Hour
)

type user struct {
	ID            string  `json:"id"`
	Email         string  `json:"email"`
	Name          string  `json:"name"`
	DefaultShopID *string `json:"defaultShopId"`
}

type ctxKey struct{}

func currentUser(r *http.Request) *user { return r.Context().Value(ctxKey{}).(*user) }

// newToken returns a random URL-safe token and the SHA-256 hash we store.
// Only hashes hit the database, so a DB leak doesn't leak live sessions.
func newToken() (string, []byte) {
	b := make([]byte, 32)
	rand.Read(b)
	tok := base64.RawURLEncoding.EncodeToString(b)
	return tok, hashToken(tok)
}

func hashToken(tok string) []byte {
	s := sha256.Sum256([]byte(tok))
	return s[:]
}

// authed wraps a handler that requires a signed-in user.
func (a *app) authed(fn func(http.ResponseWriter, *http.Request) error) http.Handler {
	return h(func(w http.ResponseWriter, r *http.Request) error {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			return errUnauthorized
		}
		u := &user{}
		err = a.db.QueryRow(r.Context(), `
			SELECT u.id, u.email, u.name, u.default_shop_id
			FROM sessions s JOIN users u ON u.id = s.user_id
			WHERE s.token_hash = $1 AND s.expires_at > now()`, hashToken(c.Value)).
			Scan(&u.ID, &u.Email, &u.Name, &u.DefaultShopID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errUnauthorized
		} else if err != nil {
			return err
		}
		return fn(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

func (a *app) startSession(ctx context.Context, w http.ResponseWriter, userID string) error {
	tok, hash := newToken()
	if _, err := a.db.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		hash, userID, time.Now().Add(sessionTTL)); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: tok, Path: "/api", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func normEmail(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if a, err := mail.ParseAddress(s); err != nil || a.Address != s || len(s) > 254 {
		return "", invalid("Enter a valid email address")
	}
	return s, nil
}

func checkPassword(p string) error {
	if len(p) < 8 || len(p) > 72 { // bcrypt only uses the first 72 bytes
		return invalid("Password must be 8–72 characters")
	}
	return nil
}

func (a *app) register(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Email, Password, Name, ShopName string }
	if err := decode(w, r, &in); err != nil {
		return err
	}
	email, err := normEmail(in.Email)
	if err != nil {
		return err
	}
	if err := checkPassword(in.Password); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if len(name) > 100 {
		return invalid("Name is too long")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var id string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
		ON CONFLICT (lower(email)) DO NOTHING RETURNING id`, email, name, string(hash)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return conflict("An account with this email already exists")
	} else if err != nil {
		return err
	}
	if s := strings.TrimSpace(in.ShopName); s != "" {
		shopName, err := cleanName(s, "Shop name")
		if err != nil {
			return err
		}
		if _, err := createShopTx(r.Context(), tx, id, shopName, "", defaultTZ, true); err != nil {
			return err
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	if err := a.startSession(r.Context(), w, id); err != nil {
		return err
	}
	return a.writeMe(w, r, id, http.StatusCreated)
}

// Spent comparing against when the email is unknown, so response time doesn't
// reveal which emails have accounts.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("not-a-real-password"), bcrypt.DefaultCost)

func (a *app) login(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Email, Password string }
	if err := decode(w, r, &in); err != nil {
		return err
	}
	var id, hash string
	err := a.db.QueryRow(r.Context(), `SELECT id, password_hash FROM users WHERE lower(email) = lower($1)`,
		strings.TrimSpace(in.Email)).Scan(&id, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(in.Password))
		return &apiError{http.StatusUnauthorized, "invalid_credentials", "Incorrect email or password"}
	} else if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
		return &apiError{http.StatusUnauthorized, "invalid_credentials", "Incorrect email or password"}
	}
	a.db.Exec(r.Context(), `DELETE FROM sessions WHERE expires_at < now()`)
	if err := a.startSession(r.Context(), w, id); err != nil {
		return err
	}
	return a.writeMe(w, r, id, http.StatusOK)
}

func (a *app) logout(w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(sessionCookie); err == nil {
		if _, err := a.db.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash = $1`, hashToken(c.Value)); err != nil {
			return err
		}
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/api", MaxAge: -1,
		HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *app) me(w http.ResponseWriter, r *http.Request) error {
	return a.writeMe(w, r, currentUser(r).ID, http.StatusOK)
}

func (a *app) writeMe(w http.ResponseWriter, r *http.Request, id string, status int) error {
	u := user{}
	if err := a.db.QueryRow(r.Context(), `SELECT id, email, name, default_shop_id FROM users WHERE id = $1`, id).
		Scan(&u.ID, &u.Email, &u.Name, &u.DefaultShopID); err != nil {
		return err
	}
	return writeJSON(w, status, map[string]any{"user": u})
}

// forgotPassword always answers 204 so it can't be used to probe for accounts.
func (a *app) forgotPassword(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Email string }
	if err := decode(w, r, &in); err != nil {
		return err
	}
	var id, email string
	err := a.db.QueryRow(r.Context(), `SELECT id, email FROM users WHERE lower(email) = lower($1)`,
		strings.TrimSpace(in.Email)).Scan(&id, &email)
	if err == nil {
		tok, hash := newToken()
		if _, err := a.db.Exec(r.Context(), `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
			hash, id, time.Now().Add(resetTTL)); err != nil {
			return err
		}
		link := strings.TrimRight(a.cfg.AppURL, "/") + "/reset-password?token=" + tok
		go a.sendResetEmail(email, link)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *app) sendResetEmail(to, link string) {
	if a.cfg.SMTPHost == "" {
		log.Printf("SMTP not configured; password reset link for %s: %s", to, link)
		return
	}
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: Reset your Frozen Shake password\r\n"+
		"Content-Type: text/plain; charset=utf-8\r\n\r\n"+
		"Someone asked to reset your Frozen Shake Cash Tracker password.\r\n\r\n"+
		"Open this link within 1 hour to choose a new one:\r\n%s\r\n\r\n"+
		"If this wasn't you, you can ignore this email.\r\n", a.cfg.SMTPFrom, to, link)
	from := a.cfg.SMTPFrom
	if addr, err := mail.ParseAddress(from); err == nil {
		from = addr.Address
	}
	var auth smtp.Auth
	if a.cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", a.cfg.SMTPUser, a.cfg.SMTPPass, a.cfg.SMTPHost)
	}
	if err := smtp.SendMail(a.cfg.SMTPHost+":"+a.cfg.SMTPPort, auth, from, []string{to}, []byte(msg)); err != nil {
		log.Printf("send reset email to %s: %v", to, err)
	}
}

func (a *app) resetPassword(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Token, Password string }
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if err := checkPassword(in.Password); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var userID string
	err = tx.QueryRow(r.Context(), `
		UPDATE password_reset_tokens SET used_at = now()
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		RETURNING user_id`, hashToken(in.Token)).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return invalid("This reset link is invalid or has expired")
	} else if err != nil {
		return err
	}
	// New password: kill every existing session and any other outstanding links.
	if _, err := tx.Exec(r.Context(), `UPDATE users SET password_hash = $2 WHERE id = $1`, userID, string(hash)); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, userID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	if err := a.startSession(r.Context(), w, userID); err != nil {
		return err
	}
	return a.writeMe(w, r, userID, http.StatusOK)
}
