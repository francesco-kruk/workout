# Il mio allenamento

Italian, mobile-friendly workout tracking, hosted as a static site on GitHub Pages.
Workout progress and timers are saved in the browser. Supabase optionally stores
each member's private workout plan and completed-workout history, and connects one
friends group through **Profilo**. Everyone uses the same website; no forks or
application servers are required.

The interface keeps a gritty, high-contrast training theme: pure-black backgrounds
and panels, bold headings, and sharp edges lit by saturated electric-purple Aura.
Black primary buttons use bright neon outlines rather than flat lavender fills;
layered light halos and luminous Aura totals create depth without gray surfaces.
Moving neon perimeter lights, diagonal energy streams, and bright progress trails
connect primary actions, workout progress, and completion states; monthly Aura points
and leaderboard scores receive extra emphasis. Decorative motion honors
reduced-motion preferences with static neon lighting instead. Red is reserved
for errors; workout states also use text and distinct border/fill styles. Visual
progress does not imply that pending workouts have already earned synchronized points.

## Run locally

For a production-like **signed-in UI preview**, run:

```sh
npm run preview
```

Open `http://127.0.0.1:8765/`. This uses the real app UI with an approved demo
account and a private-plan example. Create/edit/save plans, resume drafts, and
try training/history without signing in to Supabase. Data persists only in this
browser on this local origin. Ranking numbers are illustrative and do not
recalculate when training or approving demo manual workouts. Profilo includes a
sample manual request to approve/reject; your own manual submissions stay pending
because the preview does not impersonate other voters. No production data or credentials are used; the
preview adapter is injected only by this localhost server, not by GitHub Pages.
The banner identifies preview mode. Use `PORT=8766 npm run preview` for another port.
The profile shows the demo email; its initial password is `Anteprima123!`.
Demo email/name edits persist locally, but changed passwords exist only in memory
and reset on reload. Never enter real credentials in the preview.

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
   completed-workout measurements, shared attendance dates, and shared manual-workout
   descriptions, completion times, progression choices and review outcomes/votes. Retired objective
   tables are kept as inert legacy data, not active configuration. Email addresses stay
   in Supabase Auth and are not exposed by application tables.
2. Apply these migrations **in order**, using the SQL Editor or your normal
   Supabase migration workflow:

   ```text
   supabase/migrations/202610210001_friends_leaderboard.sql
   supabase/migrations/202610210002_private_workouts.sql
   supabase/migrations/202610240001_ranking_objectives.sql
   supabase/migrations/202610240002_consistency_ranking.sql
   supabase/migrations/202610240003_performance_tracking.sql
   supabase/migrations/202610240004_manual_workouts.sql
   supabase/migrations/202610240005_exercise_tracking.sql
   supabase/migrations/202610240006_optional_warmup.sql
   supabase/migrations/202610240007_set_notes.sql
   supabase/migrations/202610240008_required_rest.sql
   ```

   Each migration runs once; apply only migrations not already deployed. Together
   they create the private group, membership
   rules, immutable per-user plans, private history, and atomic result/attendance
   submissions, universal weekly consistency scoring, and private performance
   tracking, plus peer-reviewed manual workouts. Deploy the manual-workout migration
   before publishing the frontend that uses it. The historical objectives migration is still required in the chain;
   the following migration retires its public workflow. No existing attendance
   is discarded or invented. Deploy the optional-warm-up migration before publishing
   a frontend that saves plans without warm-up.
   Apply the set-notes migration before publishing a frontend that submits notes.
   Apply the required-rest migration before publishing the numeric-rest frontend.
   It converts existing rest strings to numbers and intervals to their upper
   bounds (for example, `"60-90 secondi"` becomes `90`). Only rest metadata is
   changed: plan/version IDs, revisions, recorded results, and attendance are
   preserved. Legacy blank rest strings (including whitespace) are converted to
   `0`, preserving their previous no-recovery behavior in bundled and user-created
   plans, old caches, and drafts. New saves/imports still require explicit numbers.
   The migration aborts atomically if any stored plan has missing or
   unconvertible rest; correct those definitions explicitly before retrying.
3. In **Authentication > URL Configuration**, set both the Site URL and an
   allowed Redirect URL to `https://francesco-kruk.github.io/workout/`, including
   the project path and trailing slash. These settings are retained for legacy
   invitations/admin email actions and profile email-change confirmations; normal sign-in and registration do not use
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
   the three tabs: **Piano**, **Allenamento**, and **Profilo**. New members without a plan land directly on **Piano** to
   create/import and save one. **Profilo** shows account settings, progress,
   standings, and private history, not the login form. An authenticated but unapproved account sees
   only an access-pending screen with retry and sign-out controls.

Signed-in tabs omit the shared app-title header; only actionable account/offline
notices appear above their content. **Esci** is available in **Profilo**, with a
separate exit control on access-pending and recovery screens. It immediately
hides the account's plan/history and stops active timers, returning to **Accedi**
without showing the example or another account's data. Local drafts, progress,
and pending completions remain isolated for the next sign-in by their owner.
If access or initial plan loading fails, an explicit recovery screen allows
retrying instead of opening an example or treating the failure as a missing plan.
An already-loaded, approved account can keep training during an outage.

### Profile and account settings

**Suono del recupero** plays one short beep when an active rest timer finishes.
During rest, the timer shows the exercise just completed and its completed-set
count, including any optional sets in the total. Skipped sets are not counted as
completed. This context remains visible while paused and after reloading.
It is enabled by default; check **Disattiva il suono del recupero** in Profilo to
mute it. This preference stays on the current browser/device, including local
mode, and is not synchronized to your account. Audio needs a user interaction;
unsupported or blocked audio is reported without preventing workout tracking.
Background or locked-screen playback is best-effort: browsers may suspend audio
or timer callbacks. Skipping rest does not play a sound, and an already-expired
timer restored on page load does not play an old alert. The AMRAP timer is unchanged.

When creating or editing a plan, **Riscaldamento comune** is optional. New plans
start without warm-up; add items or remove all of them as needed. Included items
apply to every day and remain required steps. Existing plans and history keep
their warm-up. JSON plans still require a `warmup` array, which may now be empty.

Numeric fields show validation feedback and block saving/completion for invalid
values. Reps, seconds, set counts, and AMRAP counts must be whole numbers within
their existing limits; weight allows up to two decimal places. Valid zero values
are accepted where appropriate. Exercise targets remain free text, so ranges
such as “8–12 ripetizioni” still work.

Every standard exercise requires **Recupero (secondi)** as a whole number from
0 to 3600; enter **0** explicitly for no rest. Blank values, fractions, ranges,
and strings such as `"60 secondi"` are rejected when saving or importing. In
version-2 JSON, use `"rest": 60`, not `"rest": "60"`. The app adds **secondi**
when displaying the number. Existing ranges use their upper bound for both
display and future timers; cached plans and older drafts are converted on read.
An already-running or paused timer keeps its remaining time.

Plan title, day names, exercise names and targets, required set counts, and AMRAP
duration must be filled in. Required text cannot contain only whitespace.
Warm-up is optional, but any added warm-up item needs a name and target.
Subtitles, instructions, optional set counts, and per-set notes remain optional.
AMRAP exercises do not require individual rest values.

Each standard exercise set also has **Note della serie (facoltative)**, a text
field limited to 1000 characters. Notes are saved locally with that set and included
in its private completed-workout history, performance details, and "last time"
reference after synchronization. Blank notes are omitted. They never replace
required reps/time or weight, and are not shown in the shared leaderboard.

**Profilo** shows the current display name and effective email. Expand **Nome
visualizzato**, **Modifica email**, or **Modifica password** to edit one setting
at a time. Names use the existing 1–40 character limit and update the ranking.
Email/password changes require the current password; a new password also requires
matching confirmation and at least eight characters. Supabase may enforce stronger
password policies. Passwords are never saved in app drafts or browser storage.
Changes preserve the same Auth UUID, approved membership, private plan, and history.

Email changes use Supabase Auth, not the leaderboard table. Depending on the hosted
email settings, they may take effect immediately or require confirmation links at
the old and/or new address. The profile distinguishes the effective email from a
pending address and shows confirmation instructions; it does not treat a request
as a confirmed change. Reopen/refresh Profilo after completing the confirmations.
Configure the canonical Site URL/allowed return URL above and functioning email
delivery (including custom SMTP where required) for confirmation messages. These
hosted settings are separate from the password-only login flow. The app does not
disable email-change protections; delivery failures, rate limits, or additional
provider verification requirements are shown explicitly for retry/admin help.
Signup, forgotten-password recovery, and approval rules remain unchanged.

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
It also deletes their manual submissions; pending requests for which the departing
member was an eligible voter are rejected. Already-approved attendance for other
members is retained.

## Personal workout plans and history

**Piano** opens on **Oggi**, the active training day, with a switch to **Piano
completo** for a compact, expandable overview. This is a training cycle, not a
calendar schedule. Inspecting another day does not change the active training
day or its progress. **Allenamento** remains the step-by-step training screen.
**Profilo > Progressi** leads with private exercise/circuit performance trends,
previous-result comparisons, and recorded bests, followed by current-device workout
completion, monthly training days/Punti Aura, the universal weekly multiplier,
private history, and the friends ranking.
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
  optional actual set measurements, and AMRAP rounds/extra reps. Several workouts on the same date appear separately in history
  but earn daily leaderboard credit only once.
- **History:** **Profilo > Storico privato** displays private completed workouts, with
  original exercise targets/definitions, step results, actual measurements, and AMRAP results.
  **Carica precedenti** loads older workouts in pages of 20. Missing historical
  measurements are shown as unrecorded, never zero or inferred from targets.

### Recording actual performance

In **Piano > Modifica piano**, configure each standard exercise's **Tracciamento**
as **Ripetizioni** or **Durata (secondi)** and enable **Prevede un peso** when needed.
These settings are fixed during training. In **Allenamento**, each standard-set
card has **Risultato effettivo**: enter the configured reps or seconds and, only
for weight-enabled exercises, **Peso (kg)**. **Serie completata** becomes available
only once all required values are valid and saved locally. Log 20 kg today and
22 kg next time without editing the plan.
The prescribed target remains separate. **Ultima volta** is a read-only reference
for the same set in the latest comparable recorded workout; it is never silently
prefilled as today's performance.

Inputs persist locally through navigation/reload. Use **Indietro** to correct sets
before the workout finishes. The last outstanding step automatically snapshots
all measurements into the durable completion receipt before synchronization.
Saved workouts are immutable; undo/recomplete does not rewrite a submitted result.
Start a new run to record a new workout. New runs start with blank measurements.
Changing future prescriptions still uses **Piano > Modifica piano**.

Standard-set measurements are required for explicit set completion. Blank blocks
completion; explicit 0 kg means no external
load, not measured body weight. Weight accepts 0–2000 kg with two decimals, reps and
AMRAP extra reps accept integers 0–100000, and duration accepts integer seconds
0–86400. The browser and database reject invalid values explicitly. No automatic
unit/target parsing, assisted-load inference, or estimated 1RM is performed.
Skipped sets and jump-ahead completion do not invent actual values. Historical
unrecorded values remain unrecorded. Supersets retain one result per exercise
card; use a consistent logging convention for combined movements.

After completing a standard set, a positive prescribed recovery replaces the
exercise card and set actions. Pause/resume the timer or choose **Salta recupero**.
When recovery expires, the next exercise/set appears automatically, including
after returning to the tab or reloading the page. Sets with no recovery (or zero
seconds) advance immediately; no recovery is started after the final step.
Warmup and the AMRAP circuit timer are unchanged.

AMRAP keeps the timer and full-round counter and adds **Ripetizioni extra**:
the total completed repetitions after the last full circuit. These are displayed
separately; free-text exercise targets are not converted into fractional rounds.
The timer still has to finish before **Completa AMRAP**.

### Understanding your progress

In **Profilo > Progressi > La tua evoluzione**, select an exercise/circuit and a
metric to see dated trends, per-set details, and latest-versus-previous changes.
Standard-exercise bests are independent maximum weights, reps, and seconds—not
necessarily achieved together. A heavier weight at fewer reps is not labeled an
unconditional improvement. AMRAP bests compare full rounds first, then extra reps.

Bests and previous-result queries use the whole synchronized history, not only
the first 20 workouts. Trend results paginate separately in pages of 20; the UI
states how much is loaded, and the graph represents those loaded results.
Pending offline results are identified separately and do not enter synchronized
statistics until accepted. Failures show retry controls and label retained data
with its update time.

Ordinary plan edits preserve comparison identity through the plan's optional
`trackingId` namespace and existing exercise IDs. Standard exercises also require
unchanged movement name/instructions; targets, rest, and set counts can evolve.
AMRAP comparisons require the same day identity, duration, ordered exercises,
targets, and instructions. New plans/imports receive a fresh namespace even if
their names/IDs match existing exercises. Old plans without a namespace use a
legacy namespace, retaining compatibility. Do not manually reuse IDs/namespaces
for a different movement. JSON exports preserve the namespace, but importing
deliberately starts a new history rather than guessing a link.

Only the owner can read actual performance. Friends see attendance and points,
never weights, exercise definitions, or private results. Performance does not
change ranking points.

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
validate it. Limits protect rendering and submission size: 0–50 warmup items,
1–30 days, 1–50 exercises per day, 1–30 required sets, 0–30 optional sets, at most
1500 steps per day, and AMRAP duration 1–180 minutes (for example `"20 minuti"`).
Rest is required for every standard exercise as an integer JSON number from 0
to 3600 (for example `"rest": 60`). Use `0` explicitly for no recovery; ranges,
text, and missing values are not accepted.
IDs must be unique across warmup/days/exercises, start with a letter, and contain
only letters, digits, underscores, or hyphens (up to 80 characters).
`warmup`, `constructor`, `prototype`, and `__proto__` are reserved.
Text fields allow up to 4000 characters; the browser limits a compact JSON plan
to 200000 characters. The editor generates IDs automatically.

Standard exercises use `measurementMode: "reps" | "seconds"` and
`usesWeight: true | false` for their tracking settings. New exercises default to
reps without weight. Missing fields in older version-2 plans use the same defaults;
targets are never parsed to guess a tracking mode or actual measurement. The
repository example explicitly configures every standard exercise. Apply the
exercise-tracking migration before deploying the updated frontend to validate
these fields in Supabase as well as in the browser and validation script.

## Manual workouts and peer review

In **Allenamento**, open **Allenamento alternativo / manuale** on an unfinished
planned day after finishing an alternative activity, such as a run or home workout.
Enter a nonempty description (maximum 2,000 characters) and explicitly choose:

- **Sostituisci:** replace the planned day and advance to a fresh next day once the
  submission succeeds. This does not mark the planned exercises as completed.
- **Extra:** keep the uncompleted planned day next, preserving its partial progress.

Active timers stop on successful submission. Plan progression is local to the
current device, like ordinary workout progress; votes never advance or roll back
the plan, including when a request is rejected. If the user changes day, run or
plan while an upload is in flight, the app does not overwrite the newer progress.
Submission and voting require an approved account and connectivity. Manual requests
do not enter the normal offline attendance queue. A retained submission ID supports
**Recupera / riprova lo stesso invio** after an uncertain response without creating
a duplicate; recover using the original account and plan.

The server records the completion timestamp on the first accepted submission:
there is no editable date or backdating control. Retries preserve the original
request and timestamp. The description, completion time, replace/extra choice,
review counts and outcome are shared review data, **not private exercise history**.
Do not include confidential information. The associated private plan, planned-day
definition and exercise measurements are not exposed to reviewers.

**Profilo > Allenamenti manuali** lists requests awaiting your vote and your own
submissions, with pagination and refresh controls. Requests and votes cannot be
edited or withdrawn. All other approved members at submission form a fixed
electorate; the submitter cannot vote. Approval requires
`floor(number of eligible voters / 2) + 1` approvals, not merely a majority of
votes cast. Approve as soon as that threshold is reached; reject as soon as it
becomes impossible, including ties. There is no automatic expiry: unanswered
requests can remain pending. With no other members, submission is refused.
New members cannot vote on older requests, and removing an eligible voter rejects
affected pending requests without changing the original threshold.

Pending/rejected requests earn no attendance or points. Approval atomically
credits the **completion date in Europe/Rome**, not the approval date, through the
same attendance rules below. There is still at most one credited day per user/date,
even with several approved manual or planned workouts. Late approval can restore
an earlier weekly streak and recalculate subsequent multipliers; a prior-month
completion stays in that month's score. Manual descriptions do not create invented
weights, repetitions or AMRAP performance data. Peer review assesses a member's
claim; it is not independent proof of exercise and does not change the existing
trust model for ordinary planned workouts.

## Punti Aura and universal weekly consistency

Apply the two new migrations **before publishing this frontend**. Keep the old
migrations in order; do not rerun or edit ones already applied. The consistency
migration activates immediately on its deployment date in Europe/Rome, counting
that partial week as the first eligible week. It does not wait until Monday.
Existing attendance/history is preserved. Pre-activation attendance earns base
points and cannot build a new-rule streak; no old objective bonuses carry over.
This transition is intended for the group's current zero-score starting state,
not preservation of a previously active objective-based competition.

The same rule applies automatically to every approved member—no proposals, votes,
personal packages, or configurable bonus amounts:

| Consecutive active week | Multiplier | Points per distinct workout date |
| --- | --- | --- |
| First | 1x | 10 |
| Second | 1.25x | 12.5 |
| Third | 1.5x | 15 |
| Ninth and later | 3x (cap) | 30 |

An active week has at least one credited date. Weeks run Monday–Sunday in
Europe/Rome. More dates in one week earn more daily points, not a larger multiplier.
An empty completed week resets the sequence; an unfinished current week does not
reset it early. Rest days do not create attendance. The displayed multiplier
belongs to the most recent active week in the resumable sequence, not a promise
about a future workout. With no resumable sequence it is 1x.

Points apply **immediately on synchronization** with no provisional bonuses,
Monday settlement, or cron job. Monthly scores reset, but continuity crosses month
boundaries. Each date's points belong to that date's month; tied totals share ranks.
Late offline attendance can bridge a missing week and recompute later scores,
including historical months. `friends_leaderboard(p_month)` accepts a first-of-month
date for historical totals; clients cannot choose the calculation date or activation.

Retired objective/voting RPCs are removed; legacy tables are retained without
authenticated access and no longer participate in scoring. Older frontends need
to be refreshed after deployment. Standings refresh on opening Profilo, after
sync, or with **Aggiorna / riprova**; they are not realtime and retain an update label.

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
immutable history, conflict handling, and history pagination. Ranking coverage
also exercises the real database proposal/voting UI, frozen majorities, immutable
votes, Monday activation, additive settled weekly goals, late attendance,
cross-month attribution, weekly resets, and account isolation.
The test Auth schema is a minimal stand-in for Supabase's `auth.users`/`auth.uid()`;
these checks do **not** validate hosted Auth settings, password policies, or PostgREST.
CI runs the same checks.

Before declaring a production rollout complete, verify on the configured Pages
site with three approved accounts:

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
8. Propose objectives with bonus amounts in Profile. Confirm that the proposer
   cannot vote, one friend's approval leaves the proposal pending, and both
   approvals schedule it for next Monday. Confirm a rejection ends the proposal,
   a pending proposal can be withdrawn, and all labels use Punti Aura/Aura Pts.
   After the weekly boundary, check that completed-week bonuses settle while
   the new week initially awards base points only.

The public project URL, publishable client key, and final GitHub Pages URL are
configured. This frontend flow requires no additional database migrations;
owner approval is unchanged. Enable hosted signups, disable email confirmation,
and set passwords for existing email-only accounts before rollout. Hosted
password authentication and home-screen behavior still need end-to-end
verification. GitHub Pages
publishes the repository's `main` branch at `/`; worktree changes are not live
until published there through the normal review/deployment process.
Do not send service-role keys or database/SMTP passwords.
