import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
await db.exec(`
  create role anon; create role authenticated; create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
  $$;
  grant usage on schema auth to anon,authenticated;
  grant execute on function auth.uid() to anon,authenticated;
`);
const migrationNames = [
  "202610210001_friends_leaderboard", "202610210002_private_workouts",
  "202610240001_ranking_objectives", "202610240002_consistency_ranking",
  "202610240003_performance_tracking", "202610240004_manual_workouts",
  "202610240005_exercise_tracking", "202610240006_optional_warmup",
  "202610240007_set_notes", "202610240008_required_rest", "202610260001_workout_blocks",
];
for (const name of migrationNames) {
  await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8"));
}
after(() => db.close());

async function actAs(user = alice, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || ""]);
  await db.exec(`set role ${role}`);
}
beforeEach(async () => {
  await db.exec("reset role; truncate public.friend_members,auth.users cascade;");
  for (const user of [alice, bob, outsider]) {
    await db.query("insert into auth.users values($1)", [user]);
    if (user !== outsider) await db.query(
      "insert into public.friend_members(user_id,display_name,joined_at) values($1,'Amico','2020-01-01Z')", [user]);
  }
  await actAs();
});

const plan = {
  version: 3, title: "Blocchi misti", trackingId: "mixed-lineage",
  warmup: [{ id: "warm", name: "Mobilità", target: "3 minuti" }],
  sessions: [{ id: "mixed", label: "Mista", blocks: [
    { id: "strength", label: "Forza", type: "standard", exercises: [
      { id: "squat", name: "Squat", target: "8 reps", sets: 1, optionalSets: 1, rest: 60, usesWeight: true },
    ] },
    { id: "pair", label: "Superserie", type: "superset", rounds: 2, optionalRounds: 1, restSeconds: 90, exercises: [
      { id: "push", name: "Pushup", target: "10 reps" },
      { id: "plank", name: "Plank", target: "30 s", measurementMode: "seconds" },
    ] },
    { id: "circuit", label: "Circuito", type: "amrap", durationMinutes: 10, exercises: [
      { id: "burpee", name: "Burpee", target: "5 reps" },
    ] },
    { id: "finisher", label: "Finale", type: "amrap", durationMinutes: 5, exercises: [
      { id: "jump", name: "Jump", target: "10 reps" },
    ] },
    { id: "clock", label: "EMOM", type: "emom", rounds: 2, minutes: [
      { id: "minute-a", exercises: [
        { id: "row", name: "Row", target: "8 reps", usesWeight: true },
        { id: "hold", name: "Hold", target: "20 s", measurementMode: "seconds" },
      ] },
      { id: "minute-b", exercises: [{ id: "lunge", name: "Lunge", target: "8 reps" }] },
    ] },
  ] }],
};
const legacy = {
  version: 2, title: "Legacy", trackingId: "mixed-lineage", warmup: [],
  sessions: [
    { id: "old-strength", label: "Forza", type: "standard", exercises: [
      { id: "squat", name: "Squat", target: "8 reps", sets: 1, rest: 60, usesWeight: true },
    ] },
    { id: "old-circuit", label: "Circuito", type: "amrap", duration: "10 minuti", instructions: "Continuo",
      exercises: [{ id: "burpee", name: "Burpee", target: "5 reps", instructions: "Controllato" }] },
  ],
};
function payload() {
  return {
    steps: {
      "warmup:warm": "completed", "squat:0": "completed", "squat:1": "skipped",
      "push:0": "completed", "plank:0": "completed", "push:1": "completed", "plank:1": "completed",
      "push:2": "skipped", "plank:2": "skipped",
      "circuit:amrap": "completed", "finisher:amrap": "completed", "clock:emom": "completed",
    },
    measurements: {
      "squat:0": { reps: 8, weightKg: 20.25, notes: "Profondo" },
      "push:0": { reps: 10 }, "plank:0": { seconds: 30 },
      "push:1": { reps: 9 }, "plank:1": { seconds: 25 },
    },
    blockResults: {
      circuit: { rounds: 4, extraReps: null }, finisher: { rounds: 3, extraReps: 5 },
      clock: { minutes: {
        "0": { status: "completed", measurements: { row: { reps: 8, weightKg: 12, notes: "Facile" }, hold: { seconds: 20 } } },
        "1": { status: "missed", measurements: {} },
        "2": { status: "completed", measurements: {} },
        "3": { status: "completed", measurements: { lunge: { notes: "Solo nota" } } },
      } },
    },
  };
}
async function save(definition = plan, base = null, id = randomUUID()) {
  return (await db.query("select public.save_workout_plan($1,$2,$3,$4) as p",
    [alice, id, base, JSON.stringify(definition)])).rows[0].p;
}
async function receipt(record, values = payload(), options = {}) {
  const at = options.at ?? (await db.query("select clock_timestamp()::text as at")).rows[0].at;
  return {
    user: options.user ?? alice, id: options.id ?? randomUUID(), at,
    plan: options.plan ?? record.id, session: options.session ?? "mixed", ...values,
  };
}
async function submit(r) {
  return db.query("select public.submit_workout_result_v3($1,$2,$3,$4,$5,$6,$7,$8) as day", [
    r.user, r.id, r.at, r.plan, r.session, JSON.stringify(r.steps), JSON.stringify(r.measurements), JSON.stringify(r.blockResults),
  ]);
}
async function history() {
  return (await db.query("select public.workout_history() as h")).rows[0].h;
}
async function previous(record, block, exercise = null, session = "mixed") {
  return (await db.query("select public.workout_previous_v3($1,$2,$3,$4) as p",
    [record.id, session, block, exercise])).rows[0].p;
}
async function entries() {
  return (await db.query("select * from public.workout_performance_entries()")).rows;
}
async function counts() {
  await db.exec("reset role");
  const result = (await db.query(`select
    (select count(*)::integer from public.completed_workouts) as workouts,
    (select count(*)::integer from public.gym_attendance) as attendance`)).rows[0];
  await actAs();
  return result;
}

test("v3 mixed results round-trip privately, including missed EMOM minutes, without inferred values", async () => {
  const saved = await save();
  const r = await receipt(saved);
  await submit(r);
  await submit(r);
  assert.deepEqual(await counts(), { workouts: 1, attendance: 1 });
  const h = await history();
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].session, plan.sessions[0]);
  assert.deepEqual(h[0].measurements, r.measurements);
  assert.deepEqual(h[0].block_results, r.blockResults);
  assert.equal(h[0].amrap_rounds, null);
  assert.equal(h[0].amrap_extra_reps, null);
  const all = await entries();
  assert.deepEqual(all.map((e) => e.kind).sort(), ["amrap", "amrap", "emom", "standard", "superset", "superset"]);
  assert.equal(new Set(all.map((e) => e.series_key)).size, 6);
  const emom = all.find((e) => e.kind === "emom");
  assert.equal(emom.rounds, 3);
  assert.equal(emom.extra_reps, 1);
  assert.match(emom.context, /2 giri × 2 minuti.*Row.*Hold.*Lunge/);
  assert.deepEqual(emom.sets, Object.values(r.blockResults.clock.minutes).map((m, i) => ({
    minute: i, ...m, names: i % 2 ? { lunge: "Lunge" } : { row: "Row", hold: "Hold" },
  })));
  assert.equal(emom.max_weight, null);
  assert.deepEqual((await previous(saved, "pair", "plank")).sets, [{ set: 1, seconds: 30 }, { set: 2, seconds: 25 }]);
  assert.equal((await previous(saved, "strength", "squat")).sets[0].notes, "Profondo");
  assert.equal((await previous(saved, "circuit")).rounds, 4);
  assert.equal((await previous(saved, "finisher")).extra_reps, 5);
  assert.equal((await previous(saved, "clock")).extra_reps, 1);
  for (const [block, exercise] of [[null, null], ["pair", "squat"], ["clock", "row"], ["missing", null]]) {
    await assert.rejects(previous(saved, block, exercise), /Unknown performance/);
  }
  await assert.rejects(db.query("update public.completed_workouts set block_results='{}'"), /permission denied/);
  await assert.rejects(db.query("delete from public.completed_workouts"), /permission denied/);
  await actAs(bob);
  assert.deepEqual(await history(), []);
  assert.deepEqual(await entries(), []);
  assert.equal((await db.query("select * from public.completed_workouts")).rows.length, 0);
  assert.equal((await db.query("select * from public.workout_plan_versions")).rows.length, 0);
  await assert.rejects(previous(saved, "clock"), /Unknown performance/);
});

test("v3 plan validation rejects unknown/inapplicable fields, bad IDs, numeric bounds and unsafe shapes", async () => {
  for (const mutate of [
    (p) => { p.extra = true; },
    (p) => { delete p.warmup; },
    (p) => { p.warmup = null; },
    (p) => { p.warmup[0].sets = 1; },
    (p) => { p.warmup[0].target = " "; },
    (p) => { p.sessions[0].type = "standard"; },
    (p) => { p.sessions[0].exercises = []; },
    (p) => { p.sessions[0].blocks = []; },
    (p) => { p.sessions[0].blocks = "blocks"; },
    (p) => { p.sessions[0].blocks[0] = null; },
    (p) => { p.sessions[0].blocks[0].blocks = []; },
    (p) => { p.sessions[0].blocks[0].id = "warm"; },
    (p) => { p.sessions[0].blocks[0].id = "constructor"; },
    (p) => { p.sessions[0].blocks[0].id = "x".repeat(81); },
    (p) => { p.sessions[0].blocks[0].label = "x".repeat(4001); },
    (p) => { p.sessions[0].blocks[0].exercises[0].rest = "60"; },
    (p) => { p.sessions[0].blocks[0].exercises[0].sets = 1.5; },
    (p) => { p.sessions[0].blocks[0].exercises[0].optionalSets = 31; },
    (p) => { p.sessions[0].blocks[1].exercises.pop(); },
    (p) => { p.sessions[0].blocks[1].exercises[0].rest = 0; },
    (p) => { p.sessions[0].blocks[1].exercises[0].sets = 1; },
    (p) => { p.sessions[0].blocks[1].exercises[0].measurementMode = "minutes"; },
    (p) => { p.sessions[0].blocks[1].exercises[0].usesWeight = null; },
    (p) => { p.sessions[0].blocks[1].rounds = 31; },
    (p) => { p.sessions[0].blocks[1].optionalRounds = -1; },
    (p) => { p.sessions[0].blocks[1].restSeconds = 3601; },
    (p) => { p.sessions[0].blocks[2].durationMinutes = 181; },
    (p) => { p.sessions[0].blocks[2].duration = "10 minuti"; },
    (p) => { p.sessions[0].blocks[2].exercises[0].measurementMode = "reps"; },
    (p) => { p.sessions[0].blocks[2].legacyDayId = "another-day"; },
    (p) => { for (const b of p.sessions[0].blocks.filter((b) => b.type === "amrap")) b.legacyDayId = "mixed"; },
    (p) => { p.sessions[0].blocks[4].rounds = 91; },
    (p) => { p.sessions[0].blocks[4].minutes = []; },
    (p) => { p.sessions[0].blocks[4].minutes[0].rounds = 1; },
    (p) => { p.sessions[0].blocks[4].minutes[0].id = "strength"; },
    (p) => { p.sessions[0].blocks[4].minutes[0].exercises[0].id = "squat"; },
    (p) => { p.sessions[0].blocks[4].minutes[0].exercises[0].rest = 60; },
    (p) => { p.sessions[0].blocks[4].minutes[0].exercises = {}; },
  ]) {
    const invalid = structuredClone(plan);
    mutate(invalid);
    await assert.rejects(save(invalid), /Invalid workout plan/, mutate.toString());
  }
  const withMarker = structuredClone(plan);
  withMarker.sessions[0].blocks[2].legacyDayId = "mixed";
  const saved = await save(withMarker);
  assert.deepEqual(saved.definition, withMarker);
  await assert.rejects(db.query("update public.workout_plan_versions set definition='{}'"), /permission denied/);
});

test("v3 bounds count exercise definitions, all minute slots and expanded work including warmup", async () => {
  const standard = (count, sets = 1) => ({
    version: 3, title: "Limiti", warmup: [], sessions: [{ id: "day", label: "Day", blocks: [
      { id: "block", label: "Block", type: "standard", exercises: Array.from({ length: count }, (_, i) => ({
        id: `exercise-${i}`, name: "Exercise", target: "1 rep", sets, rest: 0,
      })) },
    ] }],
  });
  let base = await save(standard(50, 30));
  const tooManyWork = standard(50, 30);
  tooManyWork.warmup.push({ id: "warm", name: "Warm", target: "1 min" });
  await assert.rejects(save(tooManyWork, base.id), /Invalid workout plan/);
  await assert.rejects(save(standard(51), base.id), /Invalid workout plan/);
  const slots = standard(1);
  slots.sessions[0].blocks = [{ id: "emom", type: "emom", label: "EMOM", rounds: 1,
    minutes: Array.from({ length: 50 }, (_, i) => ({
      id: `minute-${i}`, exercises: [{ id: `exercise-${i}`, name: "Movement", target: "1 rep" }],
    })) }];
  base = await save(slots, base.id);
  const tooManySlots = structuredClone(slots);
  tooManySlots.sessions[0].blocks[0].minutes.push({ id: "minute-extra",
    exercises: [{ id: "extra", name: "Extra", target: "1 rep" }] });
  await assert.rejects(save(tooManySlots, base.id), /Invalid workout plan/);
  const emomWork = standard(1);
  emomWork.sessions[0].blocks = [{ id: "clock", type: "emom", label: "Clock", rounds: 150,
    minutes: [{ id: "slot", exercises: Array.from({ length: 10 }, (_, i) => ({
      id: `exercise-${i}`, name: "Movement", target: "1 rep",
    })) }] }];
  base = await save(emomWork, base.id);
  emomWork.sessions[0].blocks[0].rounds = 151;
  await assert.rejects(save(emomWork, base.id), /Invalid workout plan/);
  const supersets = standard(1);
  supersets.sessions[0].blocks = [{ id: "pair", type: "superset", label: "Pair",
    rounds: 30, optionalRounds: 30, restSeconds: 3600,
    exercises: Array.from({ length: 25 }, (_, i) => ({ id: `exercise-${i}`, name: "Movement", target: "1 rep" })) }];
  base = await save(supersets, base.id);
  supersets.warmup.push({ id: "warm", name: "Warm", target: "1 min" });
  await assert.rejects(save(supersets, base.id), /Invalid workout plan/);
  const large = standard(50);
  for (const e of large.sessions[0].blocks[0].exercises) e.instructions = "a".repeat(4000);
  large.title = "a".repeat(4000);
  base = await save(large, base.id);
  large.warmup = Array.from({ length: 10 }, (_, i) => ({ id: `warm-${i}`, name: "Warm", target: "1 min", instructions: "a".repeat(4000) }));
  await assert.rejects(save(large, base.id), /Invalid workout plan/);
});

test("v3 exact step keys and whole optional-round skipping are enforced atomically", async () => {
  const saved = await save();
  for (const mutate of [
    (p) => { delete p.steps["warmup:warm"]; },
    (p) => { p.steps["warmup:warm"] = "skipped"; },
    (p) => { p.steps["circuit:amrap"] = "skipped"; },
    (p) => { p.steps["clock:emom"] = "skipped"; },
    (p) => { p.steps["squat:0"] = "skipped"; },
    (p) => { p.steps.unknown = "completed"; },
    (p) => { delete p.steps["push:0"]; p.steps.unknown = "completed"; },
    (p) => { p.steps["squat:1"] = 1; },
    (p) => { p.steps["push:2"] = "completed"; p.measurements["push:2"] = { reps: 10 }; },
    (p) => { p.steps = []; },
  ]) {
    const p = payload();
    mutate(p);
    await assert.rejects(submit(await receipt(saved, p)), /strictly complete|Invalid session|Invalid workout block/);
  }
  assert.deepEqual(await counts(), { workouts: 0, attendance: 0 });
  const p = payload();
  p.steps["push:2"] = p.steps["plank:2"] = "completed";
  p.measurements["push:2"] = { reps: 8 };
  p.measurements["plank:2"] = { seconds: 20 };
  await submit(await receipt(saved, p));
  assert.equal((await previous(saved, "pair", "push")).sets.length, 3);
});

test("v3 measurements require configured mode/weight and reject skipped, unknown and oversized data", async () => {
  const saved = await save();
  for (const mutate of [
    (p) => { delete p.measurements["squat:0"]; },
    (p) => { delete p.measurements["squat:0"].weightKg; },
    (p) => { delete p.measurements["squat:0"].reps; },
    (p) => { p.measurements["squat:0"].weightKg = 2000.01; },
    (p) => { p.measurements["squat:0"].weightKg = 1.001; },
    (p) => { p.measurements["push:0"] = { reps: 1, seconds: 1 }; },
    (p) => { p.measurements["push:0"] = { reps: 1, weightKg: 1 }; },
    (p) => { p.measurements["push:0"] = { notes: "No reps" }; },
    (p) => { p.measurements["push:0"] = {}; },
    (p) => { p.measurements["push:0"].reps = null; },
    (p) => { p.measurements["push:0"].reps = -1; },
    (p) => { p.measurements["push:0"].reps = 100001; },
    (p) => { p.measurements["push:0"].reps = 1.5; },
    (p) => { p.measurements["plank:0"] = { reps: 30 }; },
    (p) => { p.measurements["plank:0"].seconds = 86401; },
    (p) => { p.measurements["push:0"].notes = null; },
    (p) => { p.measurements["push:0"].notes = "a".repeat(1001); },
    (p) => { p.measurements["squat:1"] = { reps: 1, weightKg: 1 }; },
    (p) => { p.measurements["warmup:warm"] = { reps: 1 }; },
    (p) => { p.measurements["clock:emom"] = { reps: 1 }; },
    (p) => { p.measurements.unknown = { reps: 1 }; },
    (p) => { p.measurements = null; },
    (p) => { p.measurements.huge = "a".repeat(200001); },
  ]) {
    const p = payload();
    mutate(p);
    await assert.rejects(submit(await receipt(saved, p)), /Invalid workout block results or measurements/, mutate.toString());
  }
  assert.deepEqual(await counts(), { workouts: 0, attendance: 0 });
  const p = payload();
  p.measurements["push:0"] = { reps: 100000, notes: "a".repeat(1000) };
  p.measurements["squat:0"] = { reps: 0, weightKg: 2000 };
  p.measurements["plank:0"] = { seconds: 86400 };
  await submit(await receipt(saved, p));
});

test("AMRAP and EMOM require exactly all timed results and elapsed minute statuses with valid optional values", async () => {
  const saved = await save();
  for (const mutate of [
    (p) => { delete p.blockResults.circuit; },
    (p) => { p.blockResults.other = p.blockResults.circuit; },
    (p) => { p.blockResults.strength = {}; },
    (p) => { p.blockResults.circuit.rounds = -1; },
    (p) => { p.blockResults.circuit.rounds = 100001; },
    (p) => { p.blockResults.circuit.rounds = 1.5; },
    (p) => { delete p.blockResults.circuit.extraReps; },
    (p) => { p.blockResults.circuit.extraReps = "5"; },
    (p) => { p.blockResults.circuit.extraReps = 100001; },
    (p) => { p.blockResults.circuit.minutes = {}; },
    (p) => { p.blockResults.clock.rounds = 2; },
    (p) => { delete p.blockResults.clock.minutes["0"]; },
    (p) => { p.blockResults.clock.minutes["4"] = { status: "missed", measurements: {} }; },
    (p) => { p.blockResults.clock.minutes["00"] = p.blockResults.clock.minutes["0"]; delete p.blockResults.clock.minutes["0"]; },
    (p) => { p.blockResults.clock.minutes = []; },
    (p) => { p.blockResults.clock.minutes["0"].status = "pending"; },
    (p) => { p.blockResults.clock.minutes["0"].status = null; },
    (p) => { delete p.blockResults.clock.minutes["0"].measurements; },
    (p) => { p.blockResults.clock.minutes["1"].measurements = { lunge: { reps: 2 } }; },
    (p) => { p.blockResults.clock.minutes["0"].measurements = { lunge: { reps: 2 } }; },
    (p) => { p.blockResults.clock.minutes["0"].measurements.row = { seconds: 8 }; },
    (p) => { p.blockResults.clock.minutes["0"].measurements.hold = { weightKg: 1 }; },
    (p) => { p.blockResults.clock.minutes["0"].measurements.row = { weightKg: 1.001 }; },
    (p) => { p.blockResults.clock.minutes["0"].measurements.row = { reps: "8" }; },
    (p) => { p.blockResults.clock.minutes["0"].measurements.row = { notes: "a".repeat(1001) }; },
    (p) => { p.blockResults.clock.minutes["0"].measurements.row = { reps: 100001 }; },
    (p) => { p.blockResults.clock.minutes["0"].extra = true; },
    (p) => { p.blockResults = []; },
    (p) => { p.blockResults = null; },
    (p) => { p.blockResults.huge = "a".repeat(200001); },
  ]) {
    const p = payload();
    mutate(p);
    await assert.rejects(submit(await receipt(saved, p)), /Invalid workout block results or measurements/, mutate.toString());
  }
  assert.deepEqual(await counts(), { workouts: 0, attendance: 0 });
  const p = payload();
  p.blockResults.circuit = { rounds: 0, extraReps: 100000 };
  p.blockResults.clock.minutes["0"].measurements = { row: { weightKg: 0 }, hold: {} };
  await submit(await receipt(saved, p));
  assert.deepEqual((await history())[0].block_results.clock.minutes["2"].measurements, {});
});

test("submission ownership, membership, timestamps, RPC versions and idempotent immutable retries", async () => {
  const saved = await save();
  const r = await receipt(saved);
  for (const options of [
    { user: bob }, { plan: randomUUID() }, { session: "missing" }, { id: null },
    { at: null }, { at: "infinity" }, { at: "2999-01-01Z" }, { at: "2020-01-01Z" },
  ]) await assert.rejects(submit({ ...r, ...options }), /Membership|Unknown plan|Invalid/);
  await assert.rejects(db.query("select public.submit_workout_result($1,$2,$3,$4,'mixed',$5,null)",
    [alice, randomUUID(), r.at, saved.id, JSON.stringify(r.steps)]), /Version 3 requires/);
  for (const fn of ["submit_workout_result_base", "submit_workout_result_legacy_base"]) {
    await assert.rejects(db.query(`select public.${fn}($1,$2,$3,$4,'mixed',$5,null)`,
      [alice, randomUUID(), r.at, saved.id, JSON.stringify(r.steps)]), /permission denied/);
  }
  await actAs(bob);
  await assert.rejects(submit({ ...r, user: bob }), /Unknown plan/);
  await actAs(outsider);
  await assert.rejects(submit({ ...r, user: outsider }), /Membership/);
  await actAs(null, "anon");
  await assert.rejects(submit(r), /permission denied/);
  await actAs();
  assert.deepEqual(await counts(), { workouts: 0, attendance: 0 });
  await submit(r);
  for (const mutate of [
    (p) => { p.blockResults.circuit.rounds++; },
    (p) => { p.measurements["push:0"].reps++; },
    (p) => { p.blockResults.clock.minutes["1"] = { status: "completed", measurements: {} }; },
    (p) => { p.at = new Date().toISOString(); },
  ]) {
    const changed = structuredClone(r);
    mutate(changed);
    await assert.rejects(submit(changed), /Event ID already used/);
  }
  await submit(r);
  assert.deepEqual(await counts(), { workouts: 1, attendance: 1 });
  const original = await save(legacy, saved.id);
  await assert.rejects(submit({ ...r, id: randomUUID(), plan: original.id, at: new Date().toISOString() }), /Version 3 plan required/);
});

test("attendance failure rolls back the new result row and leaves the existing receipt immutable", async () => {
  const saved = await save();
  const r = await receipt(saved);
  await db.query("select public.submit_gym_day($1,$2,$3)", [alice, r.id, r.at]);
  await assert.rejects(submit({ ...r, at: new Date().toISOString() }), /Event ID already used/);
  assert.deepEqual(await counts(), { workouts: 0, attendance: 1 });
  await submit(r);
  assert.deepEqual(await counts(), { workouts: 1, attendance: 1 });
  await db.exec("reset role; delete from public.gym_attendance;");
  await db.query("update public.friend_members set joined_at=now() where user_id=$1", [alice]);
  await actAs();
  const beforeMembership = { ...r, id: randomUUID() };
  await assert.rejects(submit(beforeMembership), /Invalid completion timestamp/);
  assert.deepEqual(await counts(), { workouts: 1, attendance: 0 });
});

test("legacy plans, pending receipts and compatible standard/AMRAP histories keep their comparison keys", async () => {
  const old = await save(legacy);
  const at = (await db.query("select clock_timestamp()::text as at")).rows[0].at;
  const id = randomUUID();
  await db.query("select public.submit_workout_result($1,$2,$3,$4,'old-strength',$5,null,$6,null)",
    [alice, id, at, old.id, JSON.stringify({ "squat:0": "completed" }), JSON.stringify({ "squat:0": { reps: 8, weightKg: 20 } })]);
  await db.query("select public.submit_workout_result($1,$2,$3,$4,'old-circuit',$5,4,'{}',7)",
    [alice, randomUUID(), at, old.id, JSON.stringify({ "old-circuit:amrap": "completed" })]);
  const upgraded = {
    version: 3, title: "Convertita", trackingId: legacy.trackingId, warmup: [],
    sessions: legacy.sessions.map((day, i) => ({
      id: day.id, label: day.label, blocks: [{ id: `converted-${i}`, label: day.label, type: day.type,
        ...(day.instructions ? { instructions: day.instructions } : {}),
        ...(day.type === "amrap" ? { durationMinutes: 10, legacyDayId: day.id } : {}),
        exercises: structuredClone(day.exercises),
      }],
    })),
  };
  const converted = await save(upgraded, old.id);
  const oldStandard = (await db.query("select public.workout_previous($1,'old-strength','squat') as p", [old.id])).rows[0].p;
  const newStandard = await previous(converted, "converted-0", "squat", "old-strength");
  assert.equal(newStandard.series_key, oldStandard.series_key);
  const oldAmrap = (await db.query("select public.workout_previous($1,'old-circuit') as p", [old.id])).rows[0].p;
  assert.equal((await previous(converted, "converted-1", null, "old-circuit")).series_key, oldAmrap.series_key);
  await db.query("select public.submit_workout_result_v3($1,$2,$3,$4,'old-strength',$5,$6)",
    [alice, randomUUID(), new Date().toISOString(), converted.id, '{"squat:0":"completed"}', '{"squat:0":{"reps":9,"weightKg":21}}']);
  await db.query("select public.submit_workout_result_v3($1,$2,$3,$4,'old-circuit',$5,'{}',$6)",
    [alice, randomUUID(), new Date().toISOString(), converted.id,
      '{"converted-1:amrap":"completed"}', '{"converted-1":{"rounds":5,"extraReps":null}}']);
  const changed = structuredClone(upgraded);
  delete changed.sessions[1].blocks[0].legacyDayId;
  const fresh = await save(changed, converted.id);
  assert.equal(await previous(fresh, "converted-1", null, "old-circuit"), null);
  assert.equal((await previous(fresh, null, "squat", "old-strength")).rounds, null);
  await db.query("select public.submit_workout_result($1,$2,$3,$4,'old-strength',$5,null,$6,null)",
    [alice, id, at, old.id, '{"squat:0":"completed"}', '{"squat:0":{"reps":8,"weightKg":20}}']);
  await db.query("select public.submit_workout_result($1,$2,$3,$4,'old-strength',$5,null)",
    [alice, randomUUID(), new Date().toISOString(), old.id, '{"squat:0":"completed"}']);
  assert.equal((await history()).length, 5);
  assert.equal((await entries()).length, 4);
  assert.deepEqual((await history()).find((h) => h.id === id).block_results, {});
});

test("changed superset scheduling and EMOM protocols split series while compatible edits keep them", async () => {
  const original = await save();
  await submit(await receipt(original));
  const originalPair = await previous(original, "pair", "push");
  const originalClock = await previous(original, "clock");
  const edits = structuredClone(plan);
  edits.title = "Nuovo titolo";
  edits.sessions[0].blocks[1].label = "Nome diverso";
  let latest = await save(edits, original.id);
  assert.equal((await previous(latest, "pair", "push")).series_key, originalPair.series_key);
  assert.equal((await previous(latest, "clock")).series_key, originalClock.series_key);
  for (const mutate of [
    (p) => { p.sessions[0].blocks[1].restSeconds++; },
    (p) => { p.sessions[0].blocks[1].rounds++; },
    (p) => { p.sessions[0].blocks[1].optionalRounds++; },
    (p) => { p.sessions[0].blocks[1].exercises.reverse(); },
    (p) => { p.sessions[0].blocks[1].instructions = "Lento"; },
    (p) => { p.sessions[0].blocks[1].exercises[0].target = "12 reps"; },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    latest = await save(changed, latest.id);
    assert.equal(await previous(latest, "pair", "push"), null);
  }
  for (const mutate of [
    (p) => { p.sessions[0].blocks[4].rounds++; },
    (p) => { p.sessions[0].blocks[4].minutes.reverse(); },
    (p) => { p.sessions[0].blocks[4].instructions = "Lento"; },
    (p) => { p.sessions[0].blocks[4].minutes[0].exercises[0].target = "12 reps"; },
    (p) => { p.sessions[0].blocks[4].minutes[0].exercises.reverse(); },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    latest = await save(changed, latest.id);
    assert.equal(await previous(latest, "clock"), null);
  }
});

test("performance pagination retains each block series exactly once per receipt past page boundaries", async () => {
  const saved = await save();
  const at = (await db.query("select clock_timestamp()::text as at")).rows[0].at;
  const ids = [];
  for (let n = 0; n < 23; n++) {
    const r = await receipt(saved, payload(), { at });
    ids.push(r.id);
    await submit(r);
  }
  const key = (await previous(saved, "clock")).series_key;
  const page = (await db.query("select public.workout_performance($1) as p", [key])).rows[0].p;
  assert.equal(page.series.length, 6);
  assert.equal(page.results.length, 20);
  assert.equal(page.more, true);
  assert.equal(page.series.find((s) => s.series_key === key).workouts, 23);
  const last = page.results.at(-1);
  const next = (await db.query("select public.workout_performance($1,$2,$3) as p",
    [key, last.completed_at, last.id])).rows[0].p;
  assert.equal(next.more, false);
  assert.equal(next.results.length, 3);
  assert.deepEqual([...page.results, ...next.results].map((r) => r.id).sort(), ids.sort());
});
