import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const { validateWorkoutPlan } = createRequire(import.meta.url)("../assets/plan-validation.js");

const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
await db.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`);
await db.exec(await readFile(new URL("../supabase/migrations/202610210001_friends_leaderboard.sql", import.meta.url), "utf8"));
await db.exec(await readFile(new URL("../supabase/migrations/202610210002_private_workouts.sql", import.meta.url), "utf8"));
after(() => db.close());

beforeEach(async () => {
  await db.exec("reset role; truncate public.gym_attendance, public.friend_members, auth.users cascade;");
  for (const id of [alice, bob, outsider]) {
    await db.query("insert into auth.users values ($1)", [id]);
  }
  for (const [id, name] of [[alice, "Alice"], [bob, "Bob"]]) {
    await db.query(
      "insert into public.friend_members (user_id, display_name, joined_at) values ($1, $2, '2020-01-01Z')",
      [id, name]
    );
  }
  await actAs(alice);
});

async function actAs(id, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || ""]);
  await db.exec(`set role ${role}`);
}

async function submit(at, { user = alice, event = randomUUID() } = {}) {
  return db.query("select public.submit_gym_day($1, $2, $3::timestamptz) as gym_date", [user, event, at]);
}

async function board() {
  return (await db.query("select * from public.friends_leaderboard()")).rows;
}

const privatePlan = {
  version: 2, title: "Scheda privata",
  warmup: [{ id: "warm", name: "Warmup", target: "5 minuti", instructions: "" }],
  sessions: [
    { id: "strength", label: "Forza", type: "standard", exercises: [
      { id: "squat", name: "Squat", target: "5 ripetizioni", sets: 1, optionalSets: 1, rest: "60 secondi" },
    ] },
    { id: "circuit", label: "Circuito", type: "amrap", duration: "20 minuti", exercises: [
      { id: "push", name: "Piegamenti", target: "10 ripetizioni" },
    ] },
  ],
};

async function savePrivatePlan(definition = privatePlan, base = null, id = randomUUID(), userId = alice) {
  return (await db.query("select public.save_workout_plan($1, $2, $3, $4) as plan",
    [userId, id, base, JSON.stringify(definition)])).rows[0].plan;
}

async function submitPrivateResult(record, options = {}) {
  const instant = (await db.query("select clock_timestamp()::text as instant")).rows[0].instant;
  return db.query("select public.submit_workout_result($1,$2,$3,$4,$5,$6,$7)",
    [options.userId || alice, options.id || randomUUID(), options.at || instant, record.id,
      options.sessionId || "strength",
      JSON.stringify(options.steps || { "warmup:warm": "completed", "squat:0": "completed", "squat:1": "skipped" }),
      options.rounds ?? null]);
}

test("private plans are immutable, versioned, idempotent and protected against concurrent edits", async () => {
  const first = await savePrivatePlan();
  assert.equal(first.revision, 1);
  const revisedDefinition = structuredClone(privatePlan);
  revisedDefinition.title = "Seconda versione";
  const versionId = randomUUID();
  const next = await savePrivatePlan(revisedDefinition, first.id, versionId);
  assert.equal(next.revision, 2);
  assert.deepEqual(await savePrivatePlan(revisedDefinition, first.id, versionId), next);
  await assert.rejects(savePrivatePlan(privatePlan, first.id), /Plan changed on another device/);
  await assert.rejects(savePrivatePlan(privatePlan, next.id, versionId), /Version ID already used/);
  const rows = (await db.query("select * from public.workout_plan_versions order by revision")).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].definition.title, privatePlan.title);
  await assert.rejects(db.query("update public.workout_plan_versions set definition = '{}'"), /permission denied/);
  await assert.rejects(db.query("delete from public.workout_plan_versions"), /permission denied/);
  await assert.rejects(db.query("insert into public.workout_plan_versions values ($1,$2,3,$3,now())",
    [randomUUID(), alice, JSON.stringify(privatePlan)]), /permission denied/);
});

test("frontend and database validation agree on malformed imported plans and accept the repository template", async () => {
  const template = JSON.parse(await readFile(new URL("../data/workout-plan.json", import.meta.url), "utf8"));
  assert.deepEqual(validateWorkoutPlan(template), []);
  await savePrivatePlan(template);
  for (const mutation of [
    (p) => { p.version = 3; },
    (p) => { p.title = ""; },
    (p) => { p.warmup = []; },
    (p) => { p.sessions = {}; },
    (p) => { p.sessions[0].exercises = []; },
    (p) => { p.sessions[0].exercises[0].sets = 31; },
    (p) => { p.sessions[0].exercises[0].optionalSets = -1; },
    (p) => { p.sessions[0].exercises[0].rest = "1 minuto"; },
    (p) => { p.sessions[0].exercises[0].rest = "90-60 secondi"; },
    (p) => { p.sessions[0].id = "warm"; },
    (p) => { p.sessions[0].id = "__proto__"; },
    (p) => { p.sessions[1].duration = "0 minuti"; },
    (p) => { p.sessions[1].duration = "181 minuti"; },
    (p) => { p.warmup[0].id = true; },
    (p) => { p.warmup[0].instructions = {}; },
  ]) {
    const invalid = structuredClone(privatePlan);
    mutation(invalid);
    assert.ok(validateWorkoutPlan(invalid).length > 0);
    await assert.rejects(savePrivatePlan(invalid), /Invalid workout plan/);
  }
});

test("personal plans and detailed workout history are private even from approved friends", async () => {
  const plan = await savePrivatePlan();
  await submitPrivateResult(plan);
  await actAs(bob);
  assert.equal((await db.query("select * from public.workout_plan_versions")).rows.length, 0);
  assert.equal((await db.query("select * from public.completed_workouts")).rows.length, 0);
  assert.deepEqual((await db.query("select public.workout_history() as history")).rows[0].history, []);
  assert.equal((await db.query("select * from public.gym_attendance")).rows.length, 1);
  await assert.rejects(savePrivatePlan(privatePlan, null, randomUUID(), alice), /Membership required/);
  await assert.rejects(submitPrivateResult(plan, { userId: bob }), /Unknown plan version/);
  await assert.rejects(db.query("insert into public.completed_workouts (id) values ($1)", [randomUUID()]), /permission denied/);
  await actAs(outsider);
  await assert.rejects(savePrivatePlan(privatePlan, null, randomUUID(), outsider), /Membership required/);
  await actAs(null, "anon");
  await assert.rejects(db.query("select * from public.workout_plan_versions"), /permission denied/);
  await assert.rejects(db.query("select public.workout_history()"), /permission denied/);
});

test("detailed completions are atomic with attendance, idempotent, and preserve every workout on the same date", async () => {
  const plan = await savePrivatePlan();
  const at = (await db.query("select clock_timestamp()::text as instant")).rows[0].instant;
  const id = randomUUID();
  await submitPrivateResult(plan, { at, id });
  await submitPrivateResult(plan, { at, id });
  await submitPrivateResult(plan);
  assert.equal((await db.query("select * from public.completed_workouts")).rows.length, 2);
  assert.equal((await db.query("select * from public.gym_attendance")).rows.length, 1);
  assert.equal(Number((await board())[0].points), 10);
  await assert.rejects(submitPrivateResult(plan, { at, id, steps: {
    "warmup:warm": "completed", "squat:0": "completed", "squat:1": "completed",
  } }), /Event ID already used/);
  const conflictingEvent = randomUUID();
  await submit(new Date(Date.now() - 60000).toISOString(), { event: conflictingEvent });
  // The existing day deduplicates this event before it can reserve an event ID.
  await db.exec("reset role");
  await db.query("delete from public.gym_attendance where user_id = $1", [alice]);
  await actAs(alice);
  await submit(new Date(Date.now() - 60000).toISOString(), { event: conflictingEvent });
  await assert.rejects(submitPrivateResult(plan, { id: conflictingEvent }), /Event ID already used/);
  assert.equal((await db.query("select * from public.completed_workouts where id = $1", [conflictingEvent])).rows.length, 0);
});

test("server validates required/optional steps, session ownership, and AMRAP results before awarding credit", async () => {
  const plan = await savePrivatePlan();
  for (const options of [
    { sessionId: "unknown" },
    { steps: {} },
    { steps: { "warmup:warm": "skipped", "squat:0": "completed", "squat:1": "skipped" } },
    { steps: { "warmup:warm": "completed", "squat:0": "completed", "squat:1": "pending" } },
    { steps: { "warmup:warm": "completed", "squat:0": "completed", "squat:1": "skipped", extra: "completed" } },
    { rounds: 4 },
    { sessionId: "circuit", steps: { "warmup:warm": "completed", "circuit:amrap": "completed" }, rounds: -1 },
    { sessionId: "circuit", steps: { "warmup:warm": "completed", "circuit:amrap": "completed" } },
    { at: new Date(Date.now() + 86400000).toISOString() },
    { at: "2020-01-01Z" },
  ]) {
    await assert.rejects(submitPrivateResult(plan, options));
  }
  assert.equal((await db.query("select * from public.completed_workouts")).rows.length, 0);
  assert.equal((await db.query("select * from public.gym_attendance")).rows.length, 0);
  await submitPrivateResult(plan, {
    sessionId: "circuit", steps: { "warmup:warm": "completed", "circuit:amrap": "completed" }, rounds: 8,
  });
  const history = (await db.query("select public.workout_history() as history")).rows[0].history;
  assert.equal(history[0].amrap_rounds, 8);
});

test("old-version offline results remain valid and private history uses immutable original definitions", async () => {
  const original = await savePrivatePlan();
  const modified = structuredClone(privatePlan);
  modified.title = "Nuova scheda";
  modified.sessions[0].exercises[0].name = "Nuovo esercizio";
  modified.sessions[0].exercises[0].sets = 2;
  await savePrivatePlan(modified, original.id);
  await submitPrivateResult(original);
  const history = (await db.query("select public.workout_history() as history")).rows[0].history;
  assert.equal(history[0].plan_title, privatePlan.title);
  assert.equal(history[0].session.exercises[0].name, "Squat");
  assert.equal(history[0].revision, 1);
});

test("private history cursor pagination is stable when many completions share a timestamp", async () => {
  const plan = await savePrivatePlan();
  const at = (await db.query("select clock_timestamp()::text as instant")).rows[0].instant;
  for (let index = 0; index < 23; index += 1) await submitPrivateResult(plan, { at });
  const first = (await db.query("select public.workout_history() as history")).rows[0].history;
  assert.equal(first.length, 20);
  const last = first.at(-1);
  const next = (await db.query("select public.workout_history($1, $2) as history", [last.completed_at, last.id])).rows[0].history;
  assert.equal(next.length, 3);
  assert.equal(new Set([...first, ...next].map((result) => result.id)).size, 23);
});

test("owner removal of a member cascades private plans, detailed history and attendance", async () => {
  const plan = await savePrivatePlan();
  await submitPrivateResult(plan);
  await db.exec("reset role");
  await db.query("delete from public.friend_members where user_id = $1", [alice]);
  for (const table of ["workout_plan_versions", "completed_workouts", "gym_attendance"]) {
    assert.equal((await db.query(`select * from public.${table} where user_id = $1`, [alice])).rows.length, 0);
  }
});

function shift(date, days) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

async function today() {
  return (await db.query("select (now() at time zone 'Europe/Rome')::date::text as day")).rows[0].day;
}

function oracle(dates, currentDay) {
  const sorted = [...new Set(dates)].sort();
  let streak = 0;
  let previous = null;
  let points = 0;
  let gymDays = 0;
  for (const date of sorted) {
    streak = previous && (new Date(date) - new Date(previous)) / 86400000 <= 2 ? streak + 1 : 1;
    if (date.slice(0, 7) === currentDay.slice(0, 7)) {
      points += 10 * Math.min(3, 1 + (streak - 1) * 0.25);
      gymDays += 1;
    }
    previous = date;
  }
  if (!previous || (new Date(currentDay) - new Date(previous)) / 86400000 > 2) streak = 0;
  return { points, gymDays, streak };
}

test("distinct dates score with one rest day, gaps reset, and late arrivals recalculate later rewards", async () => {
  const day = await today();
  const dates = [-12, -10, -7, -6, -4, -3, -2, -1, 0].map((n) => shift(day, n));
  for (const date of [...dates].reverse()) await submit(`${date} 00:00:00 Europe/Rome`);
  const row = (await board()).find((item) => item.user_id === alice);
  const expected = oracle(dates, day);
  assert.equal(Number(row.points), expected.points);
  assert.equal(Number(row.gym_days), expected.gymDays);
  assert.equal(Number(row.current_streak), expected.streak);
  assert.equal(Number(row.multiplier), 2.5);
});

test("cap is 3x and month boundary retains the preceding streak", async () => {
  const day = await today();
  const dates = Array.from({ length: 45 }, (_, index) => shift(day, index - 44));
  for (const date of dates) await submit(`${date} 00:00:00 Europe/Rome`);
  const row = (await board())[0];
  const expected = oracle(dates, day);
  assert.equal(Number(row.points), expected.points);
  assert.equal(Number(row.current_streak), 45);
  assert.equal(Number(row.multiplier), 3);
  assert.equal(Number(row.gym_days), expected.gymDays);
  assert.equal(row.month_start.toISOString().slice(0, 10), `${day.slice(0, 7)}-01`);
});

test("one credited date despite duplicate events, retries, and multiple workouts", async () => {
  const event = randomUUID();
  const at = new Date(Date.now() - 60000).toISOString();
  await submit(at, { event });
  await submit(at, { event });
  await Promise.all([submit(at), submit(at), submit(at)]);
  const rows = (await db.query("select * from public.gym_attendance")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_id, event);
  assert.equal(Number((await board())[0].gym_days), 1);
});

test("all members appear, ties share ranks, and stale streaks expire", async () => {
  let rows = await board();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => Number(row.position)), [1, 1]);
  assert.deepEqual(rows.map((row) => Number(row.points)), [0, 0]);
  await submit(`${shift(await today(), -3)} 00:00:00 Europe/Rome`);
  rows = await board();
  const row = rows.find((item) => item.user_id === alice);
  assert.equal(Number(row.current_streak), 0);
  assert.equal(Number(row.multiplier), 1);
});

test("Europe/Rome dates cover midnight, DST transitions and year boundary", async () => {
  for (const [instant, expected] of [
    ["2025-12-31T23:30:00Z", "2026-01-01"],
    ["2026-03-28T23:30:00Z", "2026-03-29"],
    ["2026-03-29T22:30:00Z", "2026-03-30"],
    ["2025-10-25T22:30:00Z", "2025-10-26"],
    ["2025-10-26T23:30:00Z", "2025-10-27"],
  ]) {
    const result = await submit(instant);
    assert.equal(result.rows[0].gym_date.toISOString().slice(0, 10), expected);
  }
});

test("nonmembers and anonymous clients cannot read or submit private data", async () => {
  await submit(new Date(Date.now() - 60000).toISOString());
  await actAs(outsider);
  for (const table of ["friend_members", "friend_group", "gym_attendance"]) {
    assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0);
  }
  await assert.rejects(board(), /Membership required/);
  await assert.rejects(submit("2026-01-01Z", { user: outsider }), /Membership required/);
  await actAs(null, "anon");
  await assert.rejects(board(), /permission denied/);
  await assert.rejects(db.query("select * from public.friend_members"), /permission denied/);
  await assert.rejects(submit("2026-01-01Z"), /permission denied/);
});

test("clients cannot approve membership, forge attendance/scores or change another name", async () => {
  await assert.rejects(db.query("insert into public.friend_members (user_id) values ($1)", [outsider]), /permission denied/);
  await assert.rejects(db.query("update public.friend_members set joined_at = now()"), /permission denied/);
  await assert.rejects(db.query("update public.friend_members set user_id = $1 where user_id = $2", [outsider, alice]), /permission denied/);
  await assert.rejects(db.query("insert into public.gym_attendance values ($1, current_date, $2, now(), now())", [alice, randomUUID()]), /permission denied/);
  await assert.rejects(db.query("delete from public.gym_attendance"), /permission denied/);
  await assert.rejects(db.query("update public.gym_attendance set completed_at = now()"), /permission denied/);
  assert.equal((await db.query("update public.friend_members set display_name = 'Wrong' where user_id = $1 returning *", [bob])).rows.length, 0);
  assert.equal((await db.query("update public.friend_members set display_name = 'New name' where user_id = $1 returning *", [alice])).rows[0].display_name, "New name");
  await assert.rejects(db.query("update public.friend_members set display_name = '' where user_id = $1", [alice]), /check constraint/);
});

test("invalid dates, future dates, pre-membership dates and identity/account mismatches fail", async () => {
  const event = randomUUID();
  await assert.rejects(submit("not-a-date"), /invalid input syntax/);
  await assert.rejects(submit("infinity"), /Invalid completion/);
  await assert.rejects(submit(null), /Invalid completion/);
  await assert.rejects(submit(new Date(Date.now() + 86400000).toISOString()), /Invalid completion/);
  await assert.rejects(submit("2019-12-31T10:00:00Z"), /Invalid completion/);
  await assert.rejects(submit(new Date(Date.now() - 60000).toISOString(), { user: bob }), /Membership required/);
  const at = new Date(Date.now() - 60000).toISOString();
  await submit(at, { event });
  await assert.rejects(submit("2026-01-01T12:00:00Z", { event }), /Event ID already used/);
  await actAs(bob);
  await assert.rejects(submit(at, { user: bob, event }), /Event ID already used/);
});

test("workout UI -> offline receipt -> real PostgreSQL RPC -> monthly leaderboard", async (t) => {
  const dom = new JSDOM("<main></main>", {
    url: "https://example.github.io/workout/", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  for (const file of ["state", "attendance", "social", "ui", "tab-workout", "tab-leaderboard"]) {
    w.eval(await readFile(new URL(`../assets/${file}.js`, import.meta.url), "utf8"));
  }
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: alice } } }, error: null }),
      onAuthStateChange: () => {},
    },
    from: () => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({
          data: (await db.query("select user_id, display_name from public.friend_members where user_id = $1", [alice])).rows[0],
          error: null,
        }),
      };
      return chain;
    },
    rpc: async (name, args) => {
      try {
        if (name === "submit_gym_day") {
          const result = await submit(args.p_completed_at, {
            user: args.p_user_id, event: args.p_event_id,
          });
          return { data: result.rows[0].gym_date.toISOString().slice(0, 10), error: null };
        }
        return {
          data: (await board()).map((row) => ({
            ...row, month_start: row.month_start.toISOString().slice(0, 10),
          })),
          error: null,
        };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
  w.loadSupabaseClient = async () => ({ createClient: () => client });
  w.WORKOUT_SOCIAL_CONFIG = { url: "https://example.supabase.co", publishableKey: "public" };
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  const plan = {
    warmup: [{ id: "warm", name: "Riscaldamento", target: "1 min" }],
    sessions: [{
      id: "gym", label: "Giorno 1", type: "standard",
      exercises: [{ id: "squat", name: "Squat", target: "5", sets: 1, optionalSets: 1 }],
    }],
  };
  const container = w.document.querySelector("main");
  const cleanupWorkout = w.renderWorkout(container, plan, () => {});
  for (const label of ["Riscaldamento completato", "Serie completata", "Salta"]) {
    [...container.querySelectorAll("button")].find((button) => button.textContent === label).click();
  }
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.equal(Number((await board()).find((row) => row.user_id === alice).points), 0);
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 0);
  assert.match(container.textContent, /Presenza sincronizzata/);
  cleanupWorkout();
  const cleanupLeaderboard = w.renderLeaderboard(container);
  for (let attempt = 0; attempt < 100 && w.workoutSocial.snapshot().busy; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(w.workoutSocial.snapshot().busy, false);
  assert.equal(w.workoutSocial.snapshot().error, "");
  const ownRow = container.querySelector(".leaderboard-self");
  assert.ok(ownRow);
  assert.deepEqual([...ownRow.querySelectorAll("td")].map((cell) => cell.textContent), ["1", "Alice", "10", "1"]);
  cleanupLeaderboard();
});

test("full app edits a private plan and atomically syncs offline detailed results to the real database", async (t) => {
  await savePrivatePlan();
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://example.github.io/workout/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.scrollTo = () => {};
  const scripts = [...html.matchAll(/<script src="assets\/([^"]+)"><\/script>/g)].map((match) => match[1]);
  for (const file of scripts.filter((file) => file !== "app.js")) {
    w.eval(await readFile(new URL(`../assets/${file}`, import.meta.url), "utf8"));
  }
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: alice } } }, error: null }),
      onAuthStateChange: () => {},
    },
    from: (table) => {
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({
          data: (await db.query(table === "friend_members"
            ? "select user_id, display_name from public.friend_members where user_id = $1"
            : "select * from public.workout_plan_versions where user_id = $1 order by revision desc limit 1",
          [alice])).rows[0] || null, error: null,
        }),
      };
      return chain;
    },
    rpc: async (name, args) => {
      try {
        if (name === "friends_leaderboard") {
          return { data: (await board()).map((row) => ({ ...row, month_start: row.month_start.toISOString().slice(0, 10) })), error: null };
        }
        if (name === "save_workout_plan") {
          return { data: await savePrivatePlan(args.p_definition, args.p_base_version_id, args.p_version_id, args.p_user_id), error: null };
        }
        if (name === "workout_history") {
          return { data: (await db.query("select public.workout_history($1,$2) as history", [args.p_before_completed_at, args.p_before_id])).rows[0].history, error: null };
        }
        if (name === "submit_workout_result") {
          await db.query("select public.submit_workout_result($1,$2,$3,$4,$5,$6,$7)",
            [args.p_user_id, args.p_event_id, args.p_completed_at, args.p_plan_version_id,
              args.p_session_id, JSON.stringify(args.p_steps), args.p_amrap_rounds]);
          return { data: "accepted", error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      } catch (error) { return { data: null, error }; }
    },
  };
  w.loadSupabaseClient = async () => ({ createClient: () => client });
  w.WORKOUT_SOCIAL_CONFIG = { url: "https://example.supabase.co", publishableKey: "public" };
  w.loadPlan = async () => structuredClone(privatePlan);
  w.eval(await readFile(new URL("../assets/app.js", import.meta.url), "utf8"));
  await w.workoutSocial.init();
  assert.equal(w.workoutLibrary.snapshot().record.revision, 1);
  w.document.querySelector('[data-view="plan"]').click();
  const click = (label) => {
    const button = [...w.document.querySelectorAll("button")].find((element) => element.textContent === label);
    assert.ok(button, label);
    button.click();
  };
  click("Modifica piano");
  const title = [...w.document.querySelectorAll("label")].find((label) => label.firstChild.textContent === "Titolo della scheda").querySelector("input");
  title.value = "Versione personale aggiornata";
  title.dispatchEvent(new w.Event("input", { bubbles: true }));
  w.document.querySelector(".plan-editor").dispatchEvent(new w.Event("submit", { cancelable: true }));
  for (let attempt = 0; attempt < 100 && w.workoutLibrary.snapshot().record.revision !== 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(w.workoutLibrary.snapshot().record.revision, 2);
  w.document.querySelector('[data-view="workout"]').click();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  for (const label of ["Riscaldamento completato", "Serie completata", "Salta"]) click(label);
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.equal(w.pendingAttendance(alice)[0].workout.planVersionId, w.workoutLibrary.snapshot().record.id);
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.workoutSocial.snapshot().error, "");
  assert.equal(w.pendingAttendance(alice).length, 0);
  const history = w.workoutLibrary.snapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].plan_title, "Versione personale aggiornata");
  assert.equal(history[0].revision, 2);
  assert.equal(history[0].steps["squat:1"], "skipped");
  assert.equal(Number((await board())[0].points), 10);
  w.document.querySelector('[data-view="profile"]').click();
  for (let attempt = 0; attempt < 100 && w.workoutLibrary.snapshot().historyLoading; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(w.document.querySelector("#workout-app").textContent, /Versione personale aggiornata \(v2\)/);
});
