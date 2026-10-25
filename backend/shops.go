package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const defaultTZ = "Asia/Kolkata"

var (
	defaultCategories = []string{"Shop Stock", "Shop Utilities", "Salaries", "Advance"}
	defaultPartners   = []string{"Falah", "Kais", "Hussain", "Raees", "Alkama"}
)

type role int

const (
	roleMember role = iota
	roleOwner
)

type shopCtx struct {
	ID   string
	Role string
	User *user
}

// shop wraps every /api/shops/{shopId}/... handler. It is the single tenant
// gate: the shop must exist AND the signed-in user must be a member, otherwise
// 404 (we don't reveal whether someone else's shop id exists). Handlers then
// scope every query with sc.ID.
func (a *app) shop(min role, fn func(http.ResponseWriter, *http.Request, shopCtx) error) http.Handler {
	return a.authed(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "shopId")
		if err != nil {
			return err
		}
		sc := shopCtx{ID: id, User: currentUser(r)}
		err = a.db.QueryRow(r.Context(), `SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`,
			id, sc.User.ID).Scan(&sc.Role)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		} else if err != nil {
			return err
		}
		if min == roleOwner && sc.Role != "owner" {
			return errForbidden
		}
		return fn(w, r, sc)
	})
}

type shopJSON struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Address   string    `json:"address"`
	Timezone  string    `json:"timezone"`
	Role      string    `json:"role"`
	IsDefault bool      `json:"isDefault"`
	CreatedAt time.Time `json:"createdAt"`
}

const shopSelect = `
	SELECT s.id, s.name, s.address, s.timezone, m.role, u.default_shop_id IS NOT DISTINCT FROM s.id, s.created_at
	FROM shops s
	JOIN shop_members m ON m.shop_id = s.id
	JOIN users u ON u.id = m.user_id
	WHERE m.user_id = $1`

func scanShop(row pgx.Row) (s shopJSON, err error) {
	err = row.Scan(&s.ID, &s.Name, &s.Address, &s.Timezone, &s.Role, &s.IsDefault, &s.CreatedAt)
	return
}

func (a *app) listShops(w http.ResponseWriter, r *http.Request) error {
	rows, err := a.db.Query(r.Context(), shopSelect+` ORDER BY s.created_at`, currentUser(r).ID)
	if err != nil {
		return err
	}
	shops, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (shopJSON, error) { return scanShop(row) })
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"shops": shops})
}

func (a *app) getShop(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	s, err := scanShop(a.db.QueryRow(r.Context(), shopSelect+` AND s.id = $2`, sc.User.ID, sc.ID))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"shop": s})
}

type shopInput struct {
	Name      *string
	Address   *string
	Timezone  *string
	IsDefault *bool
}

func (in *shopInput) validate() error {
	if in.Name != nil {
		n, err := cleanName(*in.Name, "Shop name")
		if err != nil {
			return err
		}
		in.Name = &n
	}
	if in.Address != nil {
		ad := strings.TrimSpace(*in.Address)
		if len(ad) > 300 {
			return invalid("Address is too long")
		}
		in.Address = &ad
	}
	if in.Timezone != nil {
		if _, err := time.LoadLocation(*in.Timezone); err != nil || *in.Timezone == "" || *in.Timezone == "Local" {
			return invalid("Unknown timezone")
		}
	}
	return nil
}

func (a *app) createShop(w http.ResponseWriter, r *http.Request) error {
	var in shopInput
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if in.Name == nil {
		return invalid("Shop name is required")
	}
	if err := in.validate(); err != nil {
		return err
	}
	address, tz := "", defaultTZ
	if in.Address != nil {
		address = *in.Address
	}
	if in.Timezone != nil {
		tz = *in.Timezone
	}
	u := currentUser(r)
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	makeDefault := u.DefaultShopID == nil || (in.IsDefault != nil && *in.IsDefault)
	id, err := createShopTx(r.Context(), tx, u.ID, *in.Name, address, tz, makeDefault)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	s, err := scanShop(a.db.QueryRow(r.Context(), shopSelect+` AND s.id = $2`, u.ID, id))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, map[string]any{"shop": s})
}

// createShopTx creates a shop owned by userID and seeds its default expense
// categories and partners.
func createShopTx(ctx context.Context, tx pgx.Tx, userID, name, address, tz string, makeDefault bool) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO shops (name, address, timezone) VALUES ($1, $2, $3) RETURNING id`,
		name, address, tz).Scan(&id); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, 'owner')`, id, userID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO expense_categories (shop_id, name, is_default, sort_order)
		SELECT $1, n, true, i FROM unnest($2::text[]) WITH ORDINALITY AS t(n, i)`, id, defaultCategories); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO partners (shop_id, name, sort_order)
		SELECT $1, n, i FROM unnest($2::text[]) WITH ORDINALITY AS t(n, i)`, id, defaultPartners); err != nil {
		return "", err
	}
	if makeDefault {
		if _, err := tx.Exec(ctx, `UPDATE users SET default_shop_id = $1 WHERE id = $2`, id, userID); err != nil {
			return "", err
		}
	}
	return id, nil
}

func (a *app) updateShop(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	var in shopInput
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	if (in.Name != nil || in.Address != nil || in.Timezone != nil) && sc.Role != "owner" {
		return errForbidden
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `
		UPDATE shops SET name = COALESCE($2, name), address = COALESCE($3, address),
			timezone = COALESCE($4, timezone), updated_at = now()
		WHERE id = $1`, sc.ID, in.Name, in.Address, in.Timezone); err != nil {
		return err
	}
	if in.IsDefault != nil {
		// Default shop is a per-user preference, so any member may set it.
		if _, err := tx.Exec(r.Context(), `
			UPDATE users SET default_shop_id = CASE WHEN $3 THEN $2::uuid
				WHEN default_shop_id = $2::uuid THEN NULL ELSE default_shop_id END
			WHERE id = $1`, sc.User.ID, sc.ID, *in.IsDefault); err != nil {
			return err
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return a.getShop(w, r, sc)
}

func (a *app) deleteShop(w http.ResponseWriter, r *http.Request, sc shopCtx) error {
	// Cascades to every record of this shop (and only this shop).
	if _, err := a.db.Exec(r.Context(), `DELETE FROM shops WHERE id = $1`, sc.ID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
