import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const carol = "33333333-3333-4333-8333-333333333333";
const dave = "44444444-4444-4444-8444-444444444444";
const eve = "55555555-5555-4555-8555-555555555555";
const plan = {
  version: 2, title: "Private plan",
  warmup: [{ id: "warm", name: "Warmup", target: "5 minutes" }],
  sessions: [{ id: "strength", label: "Private day", type: "standard",
    exercises: [{ id: "squat", name: "Squat", target: "5 reps", sets: 1 }] }],
};
await db.exec(`
  create role anon; create role authenticated; create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`);
const migrationDir = new URL("../supabase/migrations/", import.meta.url);
for (const name of (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort()) {
  await db.exec(await readFile(new URL(name, migrationDir), "utf8"));
}
after(() => db.close());
async function actAs(id, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || ""]);
  await db.exec(`set role ${role}`);
}
async function addMember(id) {
  await db.exec("reset role");
  await db.query("insert into public.friend_members(user_id,display_name,joined_at) values ($1,$2,'2020-01-01Z')", [id, id === alice ? "Alice" : "Friend"]);
}
let version;
beforeEach(async () => {
  await db.exec("reset role; truncate auth.users,public.friend_members cascade; update public.consistency_settings set starts_on='2020-01-01';");
  for (const id of [alice, bob, carol, dave, eve]) await db.query("insert into auth.users values ($1)", [id]);
  await addMember(alice);
  await addMember(bob);
  await actAs(alice);
  version = randomUUID();
  await db.query("select public.save_workout_plan($1,$2,null,$3)", [alice, version, JSON.stringify(plan)]);
});
async function submit({ id = randomUUID(), planId = version, session = "strength", description = "Home workout: pushups for 30 minutes", replaces = true } = {}) {
  return (await db.query("select public.submit_manual_workout($1,$2,$3,$4,$5) as result",
    [id, planId, session, description, replaces])).rows[0].result;
}
async function vote(id, approve = true) {
  return (await db.query("select public.vote_manual_workout($1,$2) as result", [id, approve])).rows[0].result;
}
async function activity(own = false, cursor = null) {
  return (await db.query("select public.manual_workout_activity($1,$2,$3) as result",
    [own, cursor?.completed_at || null, cursor?.id || null])).rows[0].result;
}
async function countAttendance() {
  return Number((await db.query("select count(*) as n from public.gym_attendance")).rows[0].n);
}

test("manual requests are pending, immutable, idempotent, server-timed and expose no private plan", async () => {
  const start = Date.now();
  const row = await submit({ description: "  Run 5 km  " });
  assert.equal(row.description, "Run 5 km");
  assert.equal(row.status, "pending");
  assert.ok(Date.parse(row.completed_at) >= start - 1000 && Date.parse(row.completed_at) <= Date.now() + 1000);
  assert.equal(row.required_approvals, 1);
  assert.equal(row.eligible, false);
  assert.equal(await countAttendance(), 0);
  assert.deepEqual(await submit({ id: row.id, description: "Run 5 km" }), row);
  await assert.rejects(submit({ id: row.id, description: "Changed" }), /ID already used/);
  await assert.rejects(submit({ id: row.id, replaces: false }), /ID already used/);
  assert.equal((await activity(true)).length, 1);
  assert.deepEqual(await activity(), []);
  await actAs(bob);
  const shared = (await activity())[0];
  assert.equal(shared.eligible, true);
  for (const key of ["plan_version_id", "session_id", "electorate", "steps", "measurements"]) assert.equal(key in shared, false);
  for (const query of [
    "select * from public.manual_workouts", "select * from public.manual_workout_votes",
    "update public.manual_workouts set status='approved'", "delete from public.manual_workouts",
    "select public.manual_workout_summary(null)",
  ]) await assert.rejects(db.query(query), /permission denied/);
  await assert.rejects(submit({ id: row.id }), /ID already used/);
});

test("invalid submissions, outsiders, anonymous access, self-votes and new voters are denied", async () => {
  for (const options of [{ id: null }, { description: "   " }, { description: "\t\n\r" }, { description: "x".repeat(2001) },
    { description: null }, { replaces: null }, { planId: randomUUID() }, { planId: null }, { session: "missing" }]) {
    await assert.rejects(submit(options));
  }
  const row = await submit();
  await assert.rejects(vote(row.id), /Not eligible/);
  await actAs(carol);
  await assert.rejects(submit(), /Membership required/);
  await assert.rejects(vote(row.id), /Membership required/);
  await assert.rejects(activity(), /Membership required/);
  await addMember(carol);
  await actAs(carol);
  await assert.rejects(vote(row.id), /Not eligible/);
  assert.deepEqual(await activity(), []);
  await assert.rejects(submit(), /Unknown personal plan/);
  await actAs(null, "anon");
  await assert.rejects(submit(), /permission denied/);
  await assert.rejects(vote(row.id), /permission denied/);
  await assert.rejects(activity(), /permission denied/);
});

test("one other member decides and duplicate votes cannot double-credit or change", async () => {
  const row = await submit();
  await actAs(bob);
  await assert.rejects(vote(row.id, null), /vote is required/);
  const approved = await vote(row.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.own_vote, true);
  assert.equal(await countAttendance(), 1);
  assert.deepEqual(await vote(row.id), approved);
  await assert.rejects(vote(row.id, false), /cannot be changed/);
  const attendance = (await db.query("select * from public.gym_attendance")).rows[0];
  assert.equal(new Date(attendance.completed_at).toISOString(), new Date(row.completed_at).toISOString());
  await actAs(alice);
  const another = await submit({ replaces: false });
  await actAs(bob);
  assert.equal((await vote(another.id)).status, "approved");
  assert.equal(await countAttendance(), 1);
  await actAs(alice);
  const rejected = await submit();
  await actAs(bob);
  assert.equal((await vote(rejected.id, false)).status, "rejected");
  assert.equal(await countAttendance(), 1);
});

test("strict majority rejects ties and impossible majorities, and approves early", async () => {
  await addMember(carol);
  await actAs(alice);
  const tied = await submit();
  assert.equal(tied.required_approvals, 2);
  await actAs(bob);
  assert.equal((await vote(tied.id, true)).status, "pending");
  await actAs(carol);
  assert.equal((await vote(tied.id, false)).status, "rejected");
  assert.equal(await countAttendance(), 0);
  await addMember(dave);
  await actAs(alice);
  const early = await submit();
  await actAs(bob);
  assert.equal((await vote(early.id, true)).status, "pending");
  await actAs(carol);
  assert.equal((await vote(early.id, true)).status, "approved");
  await actAs(dave);
  await assert.rejects(vote(early.id, false), /no longer pending/);
  await actAs(alice);
  const impossible = await submit();
  await actAs(bob);
  assert.equal((await vote(impossible.id, false)).status, "pending");
  await actAs(carol);
  assert.equal((await vote(impossible.id, false)).status, "rejected");
});

test("electorates are fixed; removing a voter rejects pending requests but preserves approved credit", async () => {
  const approved = await submit();
  await actAs(bob);
  await vote(approved.id);
  await actAs(alice);
  const pending = await submit();
  await addMember(carol);
  await db.query("delete from public.friend_members where user_id=$1", [bob]);
  await actAs(alice);
  const rows = await activity(true);
  assert.equal(rows.find((r) => r.id === pending.id).reason, "voter_left");
  assert.equal(rows.find((r) => r.id === pending.id).status, "rejected");
  assert.equal(rows.find((r) => r.id === approved.id).status, "approved");
  assert.equal(await countAttendance(), 1);
  await db.exec("reset role");
  await db.query("delete from public.friend_members where user_id=$1", [carol]);
  await actAs(alice);
  await assert.rejects(submit(), /At least one other/);
});

test("approval backfills the completion month and restores weekly consistency, not the approval month", async () => {
  const row = await submit();
  await db.exec("reset role");
  await db.query("update public.manual_workouts set completed_at='2026-08-31T22:30:00Z' where id=$1", [row.id]);
  for (const date of ["2026-08-24", "2026-09-07"]) {
    await db.query(`insert into public.gym_attendance(user_id,gym_date,event_id,completed_at)
      values ($1,$2,$3,($2::date+time '12:00') at time zone 'Europe/Rome')`, [alice, date, randomUUID()]);
  }
  const score = async (month) => (await db.query(
    "select * from public.consistency_scores('2026-10-24',$1) where user_id=$2", [month, alice])).rows[0];
  assert.equal(Number((await score("2026-09-01")).points), 10);
  await actAs(bob);
  await vote(row.id);
  await db.exec("reset role");
  assert.equal(Number((await score("2026-09-01")).points), 27.5);
  assert.equal(Number((await score("2026-08-01")).points), 10);
  assert.equal(Number((await score("2026-10-01")).points), 0);
  const credited = (await db.query("select gym_date::text from public.gym_attendance where event_id=$1", [row.id])).rows[0];
  assert.equal(credited.gym_date, "2026-09-01");
});

test("approval and vote roll back together if attendance insertion fails", async () => {
  const row = await submit();
  await db.exec("reset role");
  await db.query(`insert into public.gym_attendance(user_id,gym_date,event_id,completed_at)
    values ($1,'2026-01-01',$2,'2026-01-01T12:00:00Z')`, [bob, row.id]);
  await actAs(bob);
  await assert.rejects(vote(row.id), /unique constraint/);
  const pending = (await activity())[0];
  assert.equal(pending.status, "pending");
  assert.equal(pending.approvals, 0);
  assert.equal(pending.own_vote, null);
});

test("planned attendance and approved manual workouts on the same date award credit only once", async () => {
  const instant = (await db.query("select clock_timestamp()::text as at")).rows[0].at;
  const event = randomUUID();
  await db.query("select public.submit_gym_day($1,$2,$3)", [alice, event, instant]);
  const row = await submit();
  await actAs(bob);
  await vote(row.id);
  assert.equal(await countAttendance(), 1);
  assert.equal((await db.query("select event_id from public.gym_attendance")).rows[0].event_id, event);
  await actAs(alice);
  const board = (await db.query("select * from public.friends_leaderboard() where user_id=$1", [alice])).rows[0];
  assert.equal(Number(board.points), 10);
});

test("activity uses bounded stable pagination and never expires pending requests", async () => {
  for (let i = 0; i < 23; i += 1) await submit({ description: `Run ${i}` });
  const first = await activity(true);
  const second = await activity(true, first.at(-1));
  assert.equal(first.length, 20);
  assert.equal(second.length, 3);
  assert.equal(new Set([...first, ...second].map((r) => r.id)).size, 23);
  await db.exec("reset role; update public.manual_workouts set completed_at='2020-01-01Z';");
  await actAs(bob);
  const pending = await activity();
  assert.equal(pending.length, 20);
  assert.ok(pending.every((r) => r.status === "pending"));
  await assert.rejects(db.query("select public.manual_workout_activity(true,null,$1)", [randomUUID()]), /Invalid activity cursor/);
});
