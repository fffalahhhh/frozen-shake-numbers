# Frozen Shake Cash Tracker — REST API

Base path: `/api`. All bodies are JSON. Authentication is an HttpOnly session
cookie (`fs_session`, SameSite=Lax) set by register / login / reset-password.

## Conventions

- **Money** is a decimal string with up to 2 places (`"820.50"`). Requests may
  send a string or a JSON number; responses always return strings. Stored as
  `NUMERIC(12,2)`. Negative amounts are rejected; expenses and handovers must be > 0.
- **Dates** are calendar dates `YYYY-MM-DD` in the shop's timezone
  (default `Asia/Kolkata`). They are never converted through UTC.
- **Errors** are always shaped like this:

  ```json
  { "error": { "code": "validation", "message": "Amount must be more than ₹0" } }
  ```

  | Status | code | Meaning |
  |---|---|---|
  | 401 | `unauthorized` / `invalid_credentials` | Not signed in / wrong email or password |
  | 403 | `forbidden` | Signed in, but the role isn't allowed (e.g. a member editing shop details) |
  | 404 | `not_found` | Not found **or not yours**. Other users' shop ids always return 404 |
  | 409 | `conflict` | Duplicate name, email already registered, or an id that belongs to another shop |
  | 422 | `validation` | Invalid input |

- **Tenant isolation:** every `/api/shops/{shopId}/…` route first checks that
  the signed-in user is a member of `shopId`. Every query is then scoped by
  `shop_id`. Composite foreign keys stop a record from referencing another
  shop's category or partner.

## Idempotency (offline sync)

The PWA saves changes locally and replays them when it's back online, so every
write is safe to repeat:

| Write | How replays stay safe |
|---|---|
| `POST …/expenses`, `POST …/handovers` | The client sends its own UUID as `id`. This is the idempotency key. Replaying it returns the stored row with `200` instead of `201`. If the id belongs to another shop you get `409`. |
| `PUT …/revenue/{date}` | Upsert: there is exactly one row per shop per date |
| `PUT …/{id}` | Full replacement, last write wins |
| `DELETE …/expenses/{id}`, `DELETE …/handovers/{id}` | Always `204`, even if the row is already gone |

## Auth

| Method & path | Body | Response |
|---|---|---|
| `POST /auth/register` | `{email, password, name?, shopName?}` | `201 {user}` + cookie. If `shopName` is given, that first shop is created with the default categories and partners |
| `POST /auth/login` | `{email, password}` | `200 {user}` + cookie |
| `POST /auth/logout` | – | `204`, session deleted |
| `POST /auth/forgot-password` | `{email}` | Always `204`. Emails a 1-hour, single-use link (or logs it if SMTP isn't configured) |
| `POST /auth/reset-password` | `{token, password}` | `200 {user}` + new cookie. Signs out every other session |
| `GET /auth/me` | – | `{user: {id, email, name, defaultShopId}}` |

Passwords must be 8–72 characters and are stored as bcrypt hashes. Session and
reset tokens are 256-bit random values, and only their SHA-256 hashes are stored.

## Shops

| Method & path | Notes |
|---|---|
| `GET /shops` | `{shops: [{id, name, address, timezone, role, isDefault, createdAt}]}` |
| `POST /shops` | `{name, address?, timezone?, isDefault?}` → `201 {shop}`. Seeds categories (Shop Stock, Shop Utilities, Salaries, Advance) and partners (Falah, Kais, Hussain, Raees, Alkama) |
| `GET /shops/{shopId}` | `{shop}` |
| `PUT /shops/{shopId}` | Any of `{name, address, timezone}` (owner only) and `{isDefault}` (any member; this is a per-user preference) |
| `DELETE /shops/{shopId}` | Owner only. Permanently deletes the shop and all of its records |

## Revenue (one total per day)

| Method & path | Notes |
|---|---|
| `GET /shops/{shopId}/revenue?from=&to=` | `{revenue: [{date, amount, updatedAt}]}` |
| `PUT /shops/{shopId}/revenue/{date}` | `{amount}` → `{revenue: {date, amount, updatedAt}}` (upsert) |

## Expenses

| Method & path | Notes |
|---|---|
| `GET /shops/{shopId}/expenses?from=&to=&categoryId=&limit=` | `{items: [Expense]}`, newest first, up to 500 |
| `POST /shops/{shopId}/expenses` | `{id?, date, amount, categoryId, note?}` → `201 {item}` (or `200` on replay) |
| `PUT /shops/{shopId}/expenses/{id}` | `{date, amount, categoryId, note?}` → `{item}` |
| `DELETE /shops/{shopId}/expenses/{id}` | `204` |

`Expense = {id, date, amount, categoryId, categoryName, note, createdAt, updatedAt}`.
`categoryName` is copied onto the expense when it's created. It keeps the
original name if the category is later renamed or hidden, and only changes if
you move the expense to a different category.

## Partner handovers

Same shape as expenses, with `partnerId` / `partnerName` in place of the category fields:

| Method & path | Notes |
|---|---|
| `GET /shops/{shopId}/handovers?from=&to=&partnerId=&limit=` | `{items: [Handover]}` |
| `POST /shops/{shopId}/handovers` | `{id?, date, amount, partnerId, note?}` |
| `PUT /shops/{shopId}/handovers/{id}` | `{date, amount, partnerId, note?}` |
| `DELETE /shops/{shopId}/handovers/{id}` | `204` |

## Categories & partners

Categories and partners are never hard-deleted. `DELETE` deactivates them, so
historical records keep a valid reference.

| Method & path | Notes |
|---|---|
| `GET /shops/{shopId}/categories` | `{categories: [{id, name, isDefault, active}]}` |
| `POST /shops/{shopId}/categories` | `{name}`. Names are unique per shop, ignoring case |
| `PUT /shops/{shopId}/categories/{id}` | `{name?, active?}`: rename, hide or show |
| `DELETE /shops/{shopId}/categories/{id}` | Hide (`active=false`) |
| `GET /shops/{shopId}/partners?from=&to=` | `{partners: [{id, name, active, totalHandedOver, handoverCount}]}`. The totals respect the date range |
| `POST /shops/{shopId}/partners` | `{name}` |
| `PUT /shops/{shopId}/partners/{id}` | `{name?, active?}` |
| `DELETE /shops/{shopId}/partners/{id}` | Deactivate |

## History

`GET /shops/{shopId}/history?from=YYYY-MM-DD&to=YYYY-MM-DD` (both required)

```json
{
  "days": [
    { "date": "2026-10-13", "revenue": "4000.00", "expenses": "1050.00", "handovers": "500.00", "cashInHand": "2450.00" }
  ],
  "totals": { "revenue": "4000.00", "expenses": "1050.00", "handovers": "500.00", "cashInHand": "2450.00" }
}
```

Only dates that have some activity are returned, newest first.
**Cash in hand = revenue − expenses − handovers.** Handovers are not counted as expenses.
