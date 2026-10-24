import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
const bootstrap = `
  create role anon; create role authenticated; create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`;
await db.exec(bootstrap);
const migrationNames = [
  "202610210001_friends_leaderboard", "202610210002_private_workouts", "202610240001_ranking_objectives",
  "202610240002_consistency_ranking", "202610240003_performance_tracking",
];
const migrations = await Promise.all(migrationNames.map((name) =>
  readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8")));
for (const migration of migrations) await db.exec(migration);
after(() => db.close());

async function actAs(user, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user || ""]);
  await db.exec(`set role ${role}`);
}
beforeEach(async () => {
  await db.exec("reset role; truncate public.friend_members, auth.users cascade; update public.consistency_settings set starts_on = '2026-07-01';");
  for (const [id, name] of [[alice, "Alice"], [bob, "Bob"], [outsider, "Outsider"]]) {
    await db.query("insert into auth.users values ($1)", [id]);
    if (id !== outsider) await db.query("insert into public.friend_members(user_id,display_name,joined_at) values ($1,$2,'2020-01-01Z')", [id,name]);
  }
  await actAs(alice);
});
async function attend(dates, user = alice) {
  await db.exec("reset role");
  for (const day of dates) await db.query(`insert into public.gym_attendance(user_id,gym_date,event_id,completed_at)
    values ($1,$2,$3,($2::date + time '12:00') at time zone 'Europe/Rome')`, [user,day,randomUUID()]);
}
async function score(day, month = null, user = alice) {
  await db.exec("reset role");
  return (await db.query("select * from public.consistency_scores($1,$2) where user_id=$3", [day,month,user])).rows[0];
}
test("one universal weekly multiplier awards immediately and additional dates do not raise it", async () => {
  for (const user of [alice,bob]) await attend(["2026-09-07","2026-09-13","2026-09-14","2026-09-16"],user);
  for (const user of [alice,bob]) {
    const row = await score("2026-09-16",null,user);
    assert.equal(Number(row.points),45);
    assert.equal(Number(row.weekly_streak),2);
    assert.equal(Number(row.multiplier),1.25);
    assert.equal(Number(row.gym_days),4);
  }
});
test("empty completed weeks reset, but an unfinished empty week keeps the resumable sequence", async () => {
  await attend(["2026-09-07","2026-09-14"]);
  assert.equal(Number((await score("2026-09-23")).weekly_streak),2);
  assert.equal(Number((await score("2026-09-28")).weekly_streak),0);
  await attend(["2026-09-28"]);
  assert.equal(Number((await score("2026-09-28")).multiplier),1);
});
test("cap, monthly allocation, ties and offline backfill work without settlement", async () => {
  const dates = Array.from({length: 12},(_,i) => new Date(Date.UTC(2026,6,6+i*7)).toISOString().slice(0,10));
  await attend(dates);
  assert.equal(Number((await score("2026-09-28")).multiplier),3);
  assert.equal(Number((await score("2026-09-28","2026-08-01")).points),125);
  await db.exec("reset role; truncate public.gym_attendance;");
  await attend(["2026-09-07","2026-09-21"]);
  assert.equal(Number((await score("2026-09-21")).points),20);
  await attend(["2026-09-14"]);
  assert.equal(Number((await score("2026-09-21")).points),37.5);
});
test("activation is immediate and pre-activation attendance cannot create a streak", async () => {
  await db.exec("reset role; update public.consistency_settings set starts_on='2026-09-16';");
  await attend(["2026-09-07","2026-09-14","2026-09-16"]);
  assert.equal(Number((await score("2026-09-16")).weekly_streak),1);
  assert.equal(Number((await score("2026-09-16")).points),30);
  await attend(["2026-09-21"]);
  assert.equal(Number((await score("2026-09-21")).points),42.5);
});
test("zero scores stay zero and obsolete configuration and internal calculators are inaccessible", async () => {
  await actAs(alice);
  const rows = (await db.query("select * from public.friends_leaderboard()")).rows;
  assert.deepEqual(rows.map((r) => Number(r.points)),[0,0]);
  assert.deepEqual(rows.map((r) => Number(r.position)),[1,1]);
  await assert.rejects(db.query("select public.propose_ranking_objectives($1,$2)",[randomUUID(),{}]),/does not exist/);
  await assert.rejects(db.query("select * from public.consistency_scores(current_date)"),/permission denied/);
  await assert.rejects(db.query("select * from public.consistency_settings"),/permission denied/);
  await actAs(outsider);
  await assert.rejects(db.query("select * from public.friends_leaderboard()"),/Membership required/);
  await actAs(null,"anon");
  await assert.rejects(db.query("select * from public.friends_leaderboard()"),/permission denied/);
});

const plan = {
  version:2,title:"Performance",trackingId:"test-lineage",
  warmup:[{id:"warm",name:"Warmup",target:"1 min"}],
  sessions:[
    {id:"strength",label:"Forza",type:"standard",exercises:[
      {id:"squat",name:"Squat",sets:2,optionalSets:1,target:"8 reps",instructions:"Controllato"},
    ]},
    {id:"circuit",label:"Circuito",type:"amrap",duration:"20 minuti",exercises:[
      {id:"push",name:"Pushup",target:"10 reps"},
    ]},
  ],
};
async function save(definition = plan, base = null) {
  await actAs(alice);
  const record = (await db.query("select public.save_workout_plan($1,$2,$3,$4) as p",
    [alice,randomUUID(),base,JSON.stringify(definition)])).rows[0].p;
  await db.exec("reset role");
  await db.query("update public.workout_plan_versions set created_at='2026-01-01Z' where id=$1",[record.id]);
  await actAs(alice);
  return record;
}
async function complete(record, {id = randomUUID(),at = "2026-09-14T12:00:00Z",measurements = {"squat:0":{weightKg:20,reps:8}},
  session = "strength",rounds = null,extra = null} = {}) {
  await actAs(alice);
  const steps = session === "strength" ? {"warmup:warm":"completed","squat:0":"completed","squat:1":"completed","squat:2":"skipped"}
    : {"warmup:warm":"completed","circuit:amrap":"completed"};
  await db.query("select public.submit_workout_result($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [alice,id,at,record.id,session,JSON.stringify(steps),rounds,JSON.stringify(measurements),extra]);
  return id;
}
async function performance(series = null, cursor = null) {
  return (await db.query("select public.workout_performance($1,$2,$3) as p",
    [series,cursor?.completed_at || null,cursor?.id || null])).rows[0].p;
}
test("actual results are private, atomic, immutable on retry and included in history", async () => {
  const record = await save();
  const id = await complete(record);
  await complete(record,{id});
  await assert.rejects(complete(record,{id,measurements:{"squat:0":{weightKg:22,reps:8}}}),/different measurements/);
  const history = (await db.query("select public.workout_history() as h")).rows[0].h;
  assert.deepEqual(history[0].measurements,{"squat:0":{weightKg:20,reps:8}});
  assert.equal(Number((await db.query("select count(*) from public.gym_attendance")).rows[0].count),1);
  assert.equal((await performance()).series[0].best_weight,20);
  await actAs(bob);
  assert.deepEqual((await performance()).series,[]);
  assert.equal((await db.query("select count(*) from public.completed_workouts")).rows[0].count,0);
  await actAs(outsider);
  await assert.rejects(performance(),/Membership required/);
  await actAs(null,"anon");
  await assert.rejects(performance(),/permission denied/);
});
test("measurement validation rejects wrong shapes, unknown/skipped steps, precision, units and bounds without credit", async () => {
  const record = await save();
  for (const measurements of [
    null,[],{"warmup:warm":{reps:8}},{"squat:2":{reps:8}},{"unknown:0":{weightKg:1}},
    {"squat:0":{}},{"squat:0":{weightKg:-1}},{"squat:0":{weightKg:2001}},
    {"squat:0":{weightKg:0.001}},{"squat:0":{weightKg:"20"}},{"squat:0":{reps:1.5}},
    {"squat:0":{seconds:86401}},{"squat:0":{reps:100001}},{"squat:0":{reps:8,seconds:9}},
    {"squat:0":{pounds:20}},
  ]) await assert.rejects(complete(record,{measurements}),/Invalid actual workout measurements/);
  assert.equal(Number((await db.query("select count(*) from public.completed_workouts")).rows[0].count),0);
  assert.equal(Number((await db.query("select count(*) from public.gym_attendance")).rows[0].count),0);
  await complete(record,{measurements:{"squat:0":{weightKg:0,reps:0},"squat:1":{seconds:30}}});
  const data = await performance();
  assert.equal(data.series[0].best_weight,0);
  assert.equal(data.series[0].best_seconds,30);
});
test("old receipts without measurements remain accepted and never produce fabricated standard results", async () => {
  const record = await save();
  await db.query("select public.submit_workout_result($1,$2,$3,$4,$5,$6,$7)",[
    alice,randomUUID(),"2026-09-14Z",record.id,"strength",
    {"warmup:warm":"completed","squat:0":"completed","squat:1":"completed","squat:2":"skipped"},null,
  ]);
  assert.deepEqual((await performance()).series,[]);
  assert.deepEqual((await db.query("select public.workout_history() as h")).rows[0].h[0].measurements,{});
});
test("all-time bests and previous results are not limited to the 20-row history page", async () => {
  const record = await save();
  for (let i=0;i<25;i++) await complete(record,{
    at:`2026-09-${String(i+1).padStart(2,"0")}T12:00:00Z`,
    measurements:{"squat:0":{weightKg:i === 0 ? 100 : 20+i,reps:8}},
  });
  const first = await performance();
  assert.equal(first.results.length,20);
  assert.equal(first.more,true);
  assert.equal(first.series[0].workouts,25);
  assert.equal(first.series[0].best_weight,100);
  const second = await performance(first.series[0].series_key,first.results.at(-1));
  assert.equal(second.results.length,5);
  assert.equal(second.more,false);
  const prev = (await db.query("select public.workout_previous($1,'strength','squat') as p",[record.id])).rows[0].p;
  assert.equal(prev.sets[0].weightKg,44);
});
test("compatible plan edits retain comparisons; new lineages and changed movements separate them", async () => {
  const original = await save();
  await complete(original);
  const edited = structuredClone(plan);
  edited.sessions[0].exercises[0].target = "10 reps";
  edited.sessions[0].exercises[0].sets = 3;
  const next = await save(edited,original.id);
  const prev = (await db.query("select public.workout_previous($1,'strength','squat') as p",[next.id])).rows[0].p;
  assert.equal(prev.sets[0].weightKg,20);
  const imported = structuredClone(edited);
  imported.trackingId = randomUUID();
  const fresh = await save(imported,next.id);
  assert.equal((await db.query("select public.workout_previous($1,'strength','squat') as p",[fresh.id])).rows[0].p,null);
  imported.sessions[0].exercises[0].name = "Different squat";
  const changed = await save(imported,fresh.id);
  assert.equal((await db.query("select public.workout_previous($1,'strength','squat') as p",[changed.id])).rows[0].p,null);
});
test("AMRAP rounds and extra reps compare lexicographically only for the same protocol", async () => {
  const original = await save();
  await complete(original,{session:"circuit",rounds:4,extra:12,measurements:{}});
  await complete(original,{session:"circuit",rounds:5,extra:1,measurements:{},at:"2026-09-15Z"});
  assert.deepEqual((await performance()).series[0].best_amrap,{rounds:5,extra_reps:1});
  const edited = structuredClone(plan);
  edited.sessions[1].duration = "25 minuti";
  const next = await save(edited,original.id);
  assert.equal((await db.query("select public.workout_previous($1,'circuit') as p",[next.id])).rows[0].p,null);
  await assert.rejects(complete(original,{session:"circuit",rounds:5,extra:-1,measurements:{}}),/Invalid actual/);
});

test("a populated legacy database upgrades without dropping plans, results, attendance or old receipt compatibility", async (t) => {
  const upgrade = new PGlite();
  t.after(() => upgrade.close());
  await upgrade.exec(bootstrap);
  for (const migration of migrations.slice(0,3)) await upgrade.exec(migration);
  for (const id of [alice,bob]) {
    await upgrade.query("insert into auth.users values($1)",[id]);
    await upgrade.query("insert into public.friend_members(user_id,display_name,joined_at) values($1,'Amico','2020-01-01Z')",[id]);
  }
  await upgrade.query("select set_config('request.jwt.claim.sub',$1,false)",[alice]);
  await upgrade.exec("set role authenticated");
  const original = structuredClone(plan);
  delete original.trackingId;
  const record = (await upgrade.query("select public.save_workout_plan($1,$2,null,$3) as p",
    [alice,randomUUID(),JSON.stringify(original)])).rows[0].p;
  const event = randomUUID();
  const at = (await upgrade.query("select clock_timestamp()::text as at")).rows[0].at;
  const steps = {"warmup:warm":"completed","squat:0":"completed","squat:1":"completed","squat:2":"skipped"};
  await upgrade.query("select public.submit_workout_result($1,$2,$3,$4,'strength',$5,null)",
    [alice,event,at,record.id,JSON.stringify(steps)]);
  await upgrade.query("select public.propose_ranking_objectives($1,$2)",
    [randomUUID(),JSON.stringify({count:{days:2,bonus:0.5}})]);
  await upgrade.exec("reset role");
  for (const migration of migrations.slice(3)) await upgrade.exec(migration);
  await upgrade.exec("set role authenticated");
  const history = (await upgrade.query("select public.workout_history() as h")).rows[0].h;
  assert.equal(history[0].id,event);
  assert.deepEqual(history[0].measurements,{});
  await upgrade.query("select public.submit_workout_result($1,$2,$3,$4,'strength',$5,null)",
    [alice,event,at,record.id,JSON.stringify(steps)]);
  assert.equal(Number((await upgrade.query("select count(*) from public.gym_attendance")).rows[0].count),1);
  assert.equal((await upgrade.query("select public.workout_performance() as p")).rows[0].p.series.length,0);
  await assert.rejects(upgrade.query("select * from public.ranking_proposals"),/permission denied/);
});
