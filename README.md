# Il mio allenamento

Italian, mobile-friendly workout tracking, hosted as a static site on GitHub Pages.
Workout progress and timers are saved in the browser. Supabase optionally stores
each member's private workout plan and completed-workout history, and connects one
friends group through **Progressi**. Everyone uses the same website; no forks or
application servers are required.

## Run locally

For a production-like **signed-in UI preview**, run:

```sh
npm run preview
```

Open `http://127.0.0.1:8765/`. This uses the real app UI with an approved demo
account and a private-plan example. Create/edit/save plans, resume drafts, and
try training/history without signing in to Supabase. Data persists only in this
browser on this local origin. Ranking numbers are illustrative and do not
recalculate when training. No production data or credentials are used; the
preview adapter is injected only by this localhost server, not by GitHub Pages.
The banner identifies preview mode. Use `PORT=8766 npm run preview` for another port.

To use the real authentication/backend instead, serve this directory normally:

Serve this directory with a static HTTP server, for example:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/`. The public Supabase connection is configured in
`assets/social-config.js`; private features also require the database migrations,
Auth settings, and approved membership below.
With no Supabase configuration, the app opens the local example and saves progress
only in this browser. In a configured app, sign in and load your private plan
online first; workout tracking then remains available in the already-open app
without an internet connection. Reopening the site offline
is not supported: there is no service worker.

## Configure the private leaderboard

1. Create an owner-controlled [Supabase project](https://supabase.com/docs/guides/getting-started).
   Choose its region and review current pricing, retention, and privacy terms.
   The database stores member IDs/display names, private versioned plans, private
   completed-workout results, and shared attendance dates. Email addresses stay
   in Supabase Auth and are not exposed by application tables.
2. Apply these migrations **in order**, using the SQL Editor or your normal
   Supabase migration workflow:

   ```text
   supabase/migrations/202610210001_friends_leaderboard.sql
   supabase/migrations/202610210002_private_workouts.sql
   ```

   Each migration runs once. If you already applied the leaderboard migration,
   apply only the second one. Together they create the private group, membership
   rules, immutable per-user plans, private history, and atomic result/attendance
   submissions. No existing attendance is discarded or invented.
3. In **Authentication > URL Configuration**, set both the Site URL and an
   allowed Redirect URL to `https://francesco-kruk.github.io/workout/`, including
   the project path and trailing slash. These settings are retained for legacy
   invitations/admin email actions; normal sign-in and registration do not use
   email links or redirects, including from a phone's home-screen shortcut.
   Never use a broad wildcard for production redirects.
4. Enable the **Email** authentication provider and **Allow new users to sign up**.
   **Disable Confirm email** so registration creates a session directly in the
   same window. Set the minimum password length to **8** or greater (the form
   requires at least 8 characters, and Supabase enforces any stronger policy).
   See the [password authentication guide](https://supabase.com/docs/guides/auth/passwords).
   These are hosted Supabase settings, not frontend configuration: update them
   explicitly when migrating from the previous invitation-only setup.
   SMTP is not required for this sign-in flow. Email addresses are not verified
   with confirmation disabled; verify each person's identity out of band before
   granting membership. Registration alone grants no access to private/group data.
5. Each friend, including yourself, opens **Crea un account** and chooses an email
   and password. They stay on the access-pending screen until approved.
   Find their account in **Authentication > Users**, copy its Auth user UUID,
   and approve membership with an owner-run SQL statement:

   ```sql
   insert into public.friend_members (user_id, display_name)
   values ('REPLACE-WITH-AUTH-USER-UUID', 'Amico');
   ```

   An authenticated user without a membership sees an approval message and
   cannot read or submit group data. After approval they can press
   **Aggiorna / riprova** without signing in again.
   Members can change only their own display names. There are no public
   discovery, self-approval, member-management, or multi-group screens.
6. `assets/social-config.js` is configured for
   `https://fqwmphxzcuelbfjdpznh.supabase.co`.
   When changing projects, update its HTTPS URL and **publishable client key**
   (or the legacy public `anon` key). These values are public by
   design; row-level security and authenticated functions enforce access.
   **Never put a service-role key, secret API key, SMTP password, or database
   password in frontend files, Git, or GitHub Pages.** The pinned browser client
   loads from esm.sh only when social configuration is present; npm dependencies
   are used only for development tests.
7. Publish the static files through the existing GitHub Pages setup. The configured
   app restores an existing session automatically or opens **Accedi**. Enter an
   email address and password, or choose **Crea un account** on the first visit.
   Both actions stay in the current window; no email or external browser is needed.
   The app waits for identity, membership, and the private plan before opening
   the three tabs: **Piano**, **Allenamento**, and **Progressi**. New members without a plan land directly on **Piano** to
   create/import and save one. **Progressi** shows standings and display-name
   settings, not the login form. An authenticated but unapproved account sees
   only an access-pending screen with retry and sign-out controls.

**Esci** is available in the header on every signed-in screen. It immediately
hides the account's plan/history and stops active timers, returning to **Accedi**
without showing the example or another account's data. Local drafts, progress,
and pending completions remain isolated for the next sign-in by their owner.
If access or initial plan loading fails, an explicit recovery screen allows
retrying instead of opening an example or treating the failure as a missing plan.
An already-loaded, approved account can keep training during an outage.

### Existing email-link accounts and forgotten passwords

Existing sessions, Auth user IDs, approvals, private plans, and history remain
valid. Switching the frontend does not assign passwords to existing accounts.
Do not register a second account or delete/recreate an existing user to add a
password: the same Auth user ID must be preserved.

For an existing account without a password, or a forgotten password, contact the
owner. The owner can set a new user-chosen password on that **existing** user with
Supabase's Auth Admin API (`auth.admin.updateUserById(userId, { password })`) from
a trusted administrative environment. If an old invitation is still unconfirmed,
the owner must also verify the person's identity and confirm that account.
Never run admin operations or expose admin credentials in this static app.
Afterward, sign in with the same email and the new password from the home-screen
app. There is no in-app password-reset email flow.

Use Supabase administration to remove a member or correct/delete attendance.
Deleting a `friend_members` row cascades that member's attendance. Removing a
member does not remove their Auth account; manage that separately in Auth.
Removing membership also cascades their private plans and completed history.

## Personal workout plans and history

**Piano** opens on **Oggi**, the active training day, with a switch to **Piano
completo** for a compact, expandable overview. This is a training cycle, not a
calendar schedule. Inspecting another day does not change the active training
day or its progress. **Allenamento** remains the step-by-step training screen.
**Progressi** combines current-device workout completion, synchronized monthly
training days/points, streak/multiplier, private history, and the friends ranking.
Local pending results are labeled separately from synchronized scores and history.

**Modifica piano** opens the editor for the plan title, shared warmup, ordered
training days, standard exercises with required/optional sets and rest, and
AMRAP circuits with duration and exercise targets. Days and exercises expand
only when needed. Add, remove, and reorder
items through the UI. A member can create from scratch, personalize the bundled
example, or import a version-2 JSON file; **Esporta JSON** downloads the current
draft. JSON import/export and draft discard are secondary options. Drafts stay
on the device: **Riprendi modifica** reopens one explicitly, and **Torna al piano**
leaves it intact. **Salva piano** saves the plan online. No repository editing is
necessary. PDF import and AI extraction are not yet supported.

With an existing plan, **Nuovo piano** starts a blank replacement; the current
plan remains active until the replacement is saved. An existing draft must be
resumed or explicitly discarded first, so starting a new plan cannot erase it.
The local example is read-only: creating and editing personal plans requires
an approved signed-in account.

There is one current plan per user, with immutable prior versions:

- **Publish:** saves a new version in Supabase. Pending edits remain in a
  user-specific browser draft until publication succeeds. Editing/importing while
  offline is supported in an already-open app; publishing requires connectivity.
- **Version changes:** progress is local to both the user and plan version.
  Publishing starts separate progress; old progress is retained rather than
  applied to exercises that may have changed. If another device publishes while
  a local workout is underway, the current version stays active until the member
  explicitly selects **Usa piano aggiornato**. Routine browsing assumes one
  editing device and does not expose a manual server-refresh button or version
  controls. Automatic loading and explicit error recovery remain available.
- **Conflicts:** the server rejects saving against a superseded base version.
  Export your draft before discarding/reloading and reapplying edits to the
  latest version. Concurrent saves do not silently overwrite one another.
- **Finish:** one atomic database operation stores the completed workout and
  records daily attendance. The result contains the immutable plan version,
  training-day ID, completion time, each step's completed/skipped status, and
  AMRAP rounds. Several workouts on the same date appear separately in history
  but earn daily leaderboard credit only once.
- **History:** **Progressi > Storico privato** displays private completed workouts, with
  original exercise targets/definitions, step results, and AMRAP rounds.
  **Carica precedenti** loads older results in pages of 20. We do not invent
  actual weights/repetitions: the current training UI records step completion
  and AMRAP rounds, not those additional measurements.

Database row-level security makes plans and detailed history visible only to
their owner, even among approved friends. The leaderboard shares attendance and
scores, not plan definitions or exercise results. Timers, selected day, and
in-progress workouts are not uploaded; resuming midway on another device is
not supported.

The repository's `data/workout-plan.json` remains a **public example**, not the
source for signed-in members' plans. Guest progress stays separate and is never
silently imported into an account. The example can be missing/unavailable without
blocking private plan loading or sign-in.

### JSON format

Exports/imports use the same `version: 2`, `title`, `warmup`, and `sessions`
structure as `data/workout-plan.json`. The browser, validation script, and database
validate it. Limits protect rendering and submission size: 1–50 warmup items,
1–30 days, 1–50 exercises per day, 1–30 required sets, 0–30 optional sets, at most
1500 steps per day, and AMRAP duration 1–180 minutes (for example `"20 minuti"`).
Rest is optional; when supplied it uses integer seconds from 0 to 3600, either a
single value or an ascending range (for example `"60"` or `"60-90 secondi"`).
IDs must be unique across warmup/days/exercises, start with a letter, and contain
only letters, digits, underscores, or hyphens (up to 80 characters).
`warmup`, `constructor`, `prototype`, and `__proto__` are reserved.
Text fields allow up to 4000 characters; the browser limits a compact JSON plan
to 200000 characters. The editor generates IDs automatically.

## Scoring

| Rule | Behavior |
| --- | --- |
| Gym day | All required workout steps completed; optional sets completed or skipped |
| Daily limit | One credited date per member, even with several workouts/devices |
| Calendar | Europe/Rome, including daylight-saving changes |
| Base points | 10 points for a credited date |
| Multiplier | Starts at 1x; rises by 0.25 per subsequent workout in the streak; capped at 3x |
| Streak | Monday then Wednesday continues; Monday then Thursday resets |
| Rest | No points and no multiplier increase |
| Ranking | Points earned this calendar month; tied points share a rank |
| Month boundary | Monthly points restart; streaks continue |

For example, a continuous sequence earns 10, 12.5, 15, 17.5, ... up to 30
points per gym day. The displayed multiplier belongs to the latest credited
workout in the active streak, not a promise of points on the next date.
A streak remains resumable through two calendar dates after the last workout;
if that second date passes without training, the streak resets. Rest days do
not create attendance records.

The database derives scores from distinct sorted dates. A late offline completion
can connect two streak segments and change points on later dates, including
across a month boundary. The app refreshes standings when opening the tab,
after syncing, or when **Aggiorna / riprova** is pressed; it is not a realtime feed.
When disconnected, any displayed standings are labeled with their last update.

## Offline and completion semantics

- Sign in and load approved membership while online first. If the already-open
  app disconnects, completing a workout creates a durable, user-bound local
  event with its original completion instant. Reconnect, reopen the app online,
  or press **Aggiorna / riprova** to retry. An expired session requires signing
  in again with the same account.
- Pending events are stored separately per workout run under
  `workout.attendance.*` in localStorage. Retrying or opening multiple tabs
  cannot award duplicate daily credit. Acknowledgment only follows a successful
  server response. Failures stay visible and pending; do not clear browser
  data, use a different browser/device, or rely on private browsing to preserve
  unsynced events.
- The queue never transfers between accounts. Workouts finished while signed
  out, unapproved, or before social initialization are not later attributed to
  a newly signed-in account. Complete those workouts normally, but sign in
  before a future workout to participate.
- Resetting/advancing a workout creates a new run. Re-rendering a finished
  screen or undoing/recompleting the same run cannot earn another day's credit.
  Existing undated progress is preserved but cannot reconstruct historical
  attendance. Legacy completed runs are not backfilled after undo/recomplete.
- New personal-plan events include their original detailed result, so editing
  the plan before reconnection cannot change the submitted workout. Old
  attendance-only events from the earlier implementation still synchronize,
  without fabricating exercise history for them.
- Cached plans, progress, drafts, and pending results are not encrypted in
  browser storage. Use a trusted device. Signing out hides account data in the
  UI and stops its timers; it preserves local drafts/progress and pending
  results for that account's next sign-in rather than destroying unsynced work.
- A completion is timed when the final outstanding step is completed or an
  optional step is skipped, not when a workout starts or the next day is selected.
  The AMRAP timer must reach zero before its completion button can be used.
- The server rejects malformed/future timestamps, claims before membership
  approval, and account mismatches. A device clock ahead of server time may
  require correcting the clock and retrying once the claimed instant has passed.
  A permanently invalid event needs owner investigation; do not delete the whole
  queue to fix one event. Invalid events remain pending while other valid
  events can still synchronize.
- This is an **honor-system** competition. Offline timestamps come from the device,
  and existing exercise-jump controls mark preceding steps complete. No browser
  feature can prove a physical gym visit or prevent a member from fabricating
  their own attendance. Server rules protect identities, group access, and
  score calculation, not physical-visit verification.

Missing configuration preserves local example mode. A configured app requires
sign-in and approved membership; unavailable authentication or initial backend
access is surfaced on the entry screen, with no guest bypass. Backend outages do
not interrupt an already-loaded workout. The entry screen, header, leaderboard,
and workout finish screen surface access, synchronization, or storage errors.

## Development checks

Requires Node.js 20 or newer:

```sh
npm ci
npm run validate
npm test
```

Tests use Node's built-in runner, jsdom for browser/UI flows, and PGlite to execute
the actual PostgreSQL migration and role/RLS/scoring queries in a disposable,
in-memory database. No Docker, cloud credentials, or live user data are required.
Tests also run the full editor -> private plan -> offline completion -> real
PostgreSQL result/history/scoring flow and check account/plan-version isolation,
immutable history, conflict handling, and history pagination.
The test Auth schema is a minimal stand-in for Supabase's `auth.users`/`auth.uid()`;
these checks do **not** validate hosted Auth settings, password policies, or PostgREST.
CI runs the same checks.

Before declaring a production rollout complete, verify on the configured Pages
site with two approved accounts:

1. Signed-out visits open **Accedi** without tabs or example data. Wrong passwords
   show a retryable error. Registration signs in directly and shows pending
   approval, without email confirmation or a new window. After owner approval,
   retry opens the create/import screen in **Piano**. Sign in from a phone's
   home-screen shortcut and verify that it stays in that window. Reloading
   restores a valid session without a guest plan flash. Existing accounts with
   newly set passwords retain their original plans/history.
2. Members see one another's standings and can edit only their own names.
   Unapproved accounts see no private data. Two approved members each create a
   different plan at the same URL and cannot read each other's plans/history.
3. Standard and AMRAP workout completions appear once per date; refresh,
   undo/recomplete, and multiple devices do not duplicate points.
4. Disconnect an already-open workout, finish it, and reconnect. Its pending
   presence syncs with the original date and disappears from the pending count.
5. Sign out and switch accounts with a pending event. Only the originating account
   can upload it. Workout tracking and timers still work during a backend outage.
6. Check four-tab navigation, readable standings, keyboard/form access, and
   status messages, plan editor/import/export, and private history on a narrow
   mobile viewport.
7. Edit/publish a plan after completing a workout and check that history still
   shows the original version. Edit from another device during an active
   workout and verify the explicit version-switch choice and conflict handling.

The public project URL, publishable client key, and final GitHub Pages URL are
configured. This frontend flow requires no additional database migrations;
owner approval is unchanged. Enable hosted signups, disable email confirmation,
and set passwords for existing email-only accounts before rollout. Hosted
password authentication and home-screen behavior still need end-to-end
verification. GitHub Pages
publishes the repository's `main` branch at `/`; worktree changes are not live
until published there through the normal review/deployment process.
Do not send service-role keys or database/SMTP passwords.
