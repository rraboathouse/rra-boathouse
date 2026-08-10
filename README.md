# RRA Boathouse

Boat reservation, checkout/check-in, on-the-water board, and fleet maintenance tracking for the Rockland Rowing Association. Live at **boathouse.rocklandrowing.org**.

## How it is put together

| Piece | Where | What it does |
|---|---|---|
| `index.html` | Vercel (static) | The whole app screen. One file, no build step. |
| `api/state.js` | Vercel function | GET /api/state: everything the screen shows. |
| `api/action.js` | Vercel function | POST /api/action: checkouts, check-ins, bookings, flags. |
| `api/_lib.js` | shared helper | Talks to the database. Not a public endpoint. |
| `schema.sql` | Supabase (Postgres) | Tables, safety constraints, and the starting fleet/roster data. |
| `vercel.json` | Vercel | Daily cron ping so the free database never pauses from inactivity. |
| `manifest.json`, `icons/` | Vercel | Home-screen app icon and name. |

The database enforces the two rules that matter: a club boat cannot be checked out twice at once, and two bookings for the same boat cannot overlap. Everything else is honor system by design.

## Making changes

1. Edit the file (or get a full replacement file from Claude).
2. GitHub: open the file > pencil icon > paste the complete new version > Commit. (Or Add file > Upload files to replace several at once.)
3. Vercel redeploys automatically in about 30 seconds. The URL never changes.

Always replace whole files rather than hand-editing fragments.

## Environment variables (set in Vercel, never in code)

- `SUPABASE_URL`: the Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: the service role key (secret; it is the only key that can touch the database, which is otherwise locked down)

## Admin

Roster and fleet edits: Supabase > Table Editor (`roster`, `boats` tables), spreadsheet-style. The `settings` table holds the overdue threshold (hours), default service interval (rows), and booking window (days).

## Local preview

Open `index.html` straight from disk and it runs on built-in sample data (nothing saves). Deployed, it talks to the real database.
