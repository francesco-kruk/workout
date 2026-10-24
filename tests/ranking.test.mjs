import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { JSDOM } from "jsdom";

const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const cara = "33333333-3333-4333-8333-333333333333";
const outsider = "44444444-4444-4444-8444-444444444444";
const rules = {
  streak: { step: 0.25, cap: 1 },
  count: { days: 3, bonus: 0.5 },
  schedule: { days: [1, 6, 7], bonus: 0.5 },
};
await db.exec(`
  create role anon; create role authenticated; create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`);
for (const name of ["202610210001_friends_leaderboard", "202610210002_private_workouts", "202610240001_ranking_objectives"]) {
  await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8"));
}
after(() => db.close());

async function actAs(user, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user || ""]);
  await db.exec(`set role ${role}`);
}
beforeEach(async () => {
  await db.exec("reset role; truncate public.friend_members, auth.users cascade; update public.ranking_settings set cutover = '2026-09-28';");
  for (const [id, name] of [[alice, "Alice"], [bob, "Bob"], [cara, "Cara"], [outsider, "Outsider"]]) {
    await db.query("insert into auth.users values ($1)", [id]);
    if (id !== outsider) await db.query("insert into public.friend_members(user_id, display_name, joined_at) values ($1,$2,'2020-01-01Z')", [id, name]);
  }
  await actAs(alice);
});
async function propose(definition = rules, id = randomUUID()) {
  await db.query("select public.propose_ranking_objectives($1,$2)", [id, JSON.stringify(definition)]);
  return id;
}
async function vote(id, approve = true) {
  return (await db.query("select public.vote_ranking_objectives($1,$2) as status", [id, approve])).rows[0].status;
}
async function snapshot() {
  return (await db.query("select public.ranking_objectives() as data")).rows[0].data;
}
async function fixturePackage(definition = rules, from = "2026-09-28") {
  const id = await propose(definition);
  await db.exec("reset role");
  await db.query("update public.ranking_proposals set status='approved', decided_at=now(), effective_from=$2 where id=$1", [id, from]);
  return id;
}
async function attend(dates, user = alice) {
  await db.exec("reset role");
  for (const day of dates) {
    await db.query(`insert into public.gym_attendance(user_id,gym_date,event_id,completed_at)
      values ($1,$2,$3,($2::date + time '12:00') at time zone 'Europe/Rome')`, [user, day, randomUUID()]);
  }
}
async function score(day) {
  await db.exec("reset role");
  return (await db.query("select * from public.ranking_scores($1) where user_id=$2", [day, alice])).rows[0];
}

test("three-member proposals require both other votes; retry-safe and effective next Monday", async () => {
  const id = randomUUID();
  await propose(rules, id);
  await propose(rules, id);
  await assert.rejects(propose({ count: { days: 2, bonus: 1 } }, id), /ID already used/);
  await assert.rejects(propose(), /Withdraw the pending/);
  await assert.rejects(vote(id), /Not eligible/);
  await actAs(bob);
  assert.equal(await vote(id), "pending");
  assert.equal(await vote(id), "pending");
  await assert.rejects(vote(id, false), /cannot be changed/);
  await actAs(cara);
  assert.equal(await vote(id), "approved");
  assert.equal(await vote(id), "approved");
  const proposal = (await snapshot()).proposals[0];
  assert.equal(proposal.required_approvals, 2);
  assert.equal(proposal.votes.length, 2);
  const nextMonday = (await db.query("select (date_trunc('week', now() at time zone 'Europe/Rome')::date + 7)::text as day")).rows[0].day;
  assert.equal(proposal.effective_from, nextMonday);
  await actAs(alice);
  await assert.rejects(propose(), /already scheduled/);
  await assert.rejects(db.query("select public.withdraw_ranking_objectives($1)", [id]), /no longer pending/);
});

test("one rejection ends a three-person proposal; withdrawal and immutable terminal votes", async () => {
  const id = await propose();
  await actAs(bob);
  await assert.rejects(db.query("select public.withdraw_ranking_objectives($1)", [id]), /Only the proposer/);
  assert.equal(await vote(id, false), "rejected");
  await actAs(cara);
  await assert.rejects(vote(id), /no longer pending/);
  await actAs(alice);
  const replacement = await propose();
  await db.query("select public.withdraw_ranking_objectives($1)", [replacement]);
  await db.query("select public.withdraw_ranking_objectives($1)", [replacement]);
  await propose();
});

test("membership additions do not change the electorate; removal invalidates pending proposals", async () => {
  const id = await propose();
  await db.exec("reset role");
  await db.query("insert into public.friend_members(user_id,display_name) values ($1,'New')", [outsider]);
  await actAs(outsider);
  await assert.rejects(vote(id), /Not eligible/);
  assert.equal((await snapshot()).proposals[0].required_approvals, 2);
  await actAs(bob);
  await vote(id);
  await db.exec("reset role");
  await db.query("delete from public.friend_members where user_id=$1", [cara]);
  await actAs(alice);
  assert.equal((await snapshot()).proposals[0].status, "invalidated");
  assert.match((await snapshot()).proposals[0].reason, /left the group/);
  const replacement = await propose();
  assert.equal((await snapshot()).proposals.find((p) => p.id === replacement).required_approvals, 2);
});

test("client and database objective validation agree on malformed rules and bonus precision", async (t) => {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.eval(await readFile(new URL("../assets/tab-leaderboard.js", import.meta.url), "utf8"));
  for (const invalid of [
    null, {}, [], { custom: {} }, { count: {} }, { count: { days: 0, bonus: 1 } },
    { count: { days: 8, bonus: 1 } }, { count: { days: 2.5, bonus: 1 } },
    { count: { days: "3", bonus: 1 } }, { count: { days: 3, bonus: "1" } },
    { count: { days: 3, bonus: 0 } }, { count: { days: 3, bonus: 1000 } },
    { count: { days: 3, bonus: 0.001 } }, { streak: { step: 1, cap: 0.5 } },
    { schedule: { days: [], bonus: 1 } }, { schedule: { days: [1, 1], bonus: 1 } },
    { schedule: { days: [0], bonus: 1 } }, { schedule: { days: ["1"], bonus: 1 } },
    { count: { days: 3, bonus: 1, extra: true } }, { count: null },
    { count: { days: 3, bonus: 0.010000000000000002 } },
  ]) {
    assert.ok(dom.window.validateRankingObjectives(invalid));
    await assert.rejects(propose(invalid), /Invalid objective package/);
  }
  for (const bonus of [0.01, 0.29, 0.58, 2.55, 999.99]) {
    const valid = { count: { days: 3, bonus } };
    assert.equal(dom.window.validateRankingObjectives(valid), "");
    const id = await propose(valid);
    await db.query("select public.withdraw_ranking_objectives($1)", [id]);
  }
  const id = await propose({ schedule: { days: [1, 6, 7], bonus: 999.99 } });
  assert.equal((await snapshot()).proposals[0].id, id);
});

test("nonmembers cannot read or mutate objectives, clients cannot forge approval or pick scoring dates", async () => {
  const id = await propose();
  for (const statement of [
    "select * from public.ranking_scores(current_date)",
    "select * from public.ranking_weeks(current_date)",
    "update public.ranking_proposals set status='approved'",
    "delete from public.ranking_votes",
    "update public.ranking_settings set cutover='2026-01-05'",
  ]) await assert.rejects(db.exec(statement), /permission denied/);
  await actAs(outsider);
  assert.equal((await db.query("select * from public.ranking_proposals")).rows.length, 0);
  await assert.rejects(snapshot(), /Membership required/);
  await assert.rejects(propose(), /Membership required/);
  await assert.rejects(vote(id), /Membership required/);
  await actAs(null, "anon");
  await assert.rejects(snapshot(), /permission denied/);
});

test("Monday/weekend schedule earns additive bonuses only after the week finishes", async () => {
  await fixturePackage();
  await attend(["2026-09-28", "2026-10-03", "2026-10-04"]);
  let row = await score("2026-10-04");
  assert.equal(Number(row.points), 20);
  assert.equal(Number(row.pending_bonus), 37.5);
  assert.deepEqual(row.week_days, [1, 6, 7]);
  assert.deepEqual(row.current_bonuses, { streak: 0.25, count: 0.5, schedule: 0.5 });
  row = await score("2026-10-05");
  assert.equal(Number(row.points), 45); // Only October's two workout days.
  assert.equal(Number(row.settled_multiplier), 2.25);
  assert.equal(Number(row.pending_bonus), 0);
  assert.equal(Number(row.current_streak), 0); // Old workout streak is not repurposed.
});

test("weekly continuity grows, caps and resets without erasing prior earnings; gaps within weeks are fine", async () => {
  await fixturePackage({ streak: { step: 0.5, cap: 1 } });
  await attend(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-26"]);
  assert.equal(Number((await score("2026-10-12")).points), 30); // Settled Oct 5 + current base.
  assert.equal(Number((await score("2026-10-19")).points), 40);
  const end = await score("2026-11-02");
  assert.equal(Number(end.settled_multiplier), 1.5);
  const previousMonth = await score("2026-10-31");
  assert.equal(Number(previousMonth.points), 50);
});

test("count and schedule are independent; unmet goals do not remove other bonuses", async () => {
  await fixturePackage({ count: { days: 3, bonus: 0.5 }, schedule: { days: [1], bonus: 0.75 } });
  await attend(["2026-10-05", "2026-10-10"]);
  assert.equal(Number((await score("2026-10-12")).points), 35);
  assert.equal(Number((await score("2026-10-12")).settled_multiplier), 1.75);
});

test("no approved package gives base points without a rest-day penalty", async () => {
  await attend(["2026-10-05", "2026-10-10", "2026-10-11"]);
  const row = await score("2026-10-12");
  assert.equal(Number(row.points), 30);
  assert.equal(Number(row.settled_multiplier), 1);
  assert.equal(Number(row.gym_days), 3);
});

test("immutable effective versions and late attendance recompute the original and following weeks", async () => {
  await fixturePackage({ streak: { step: 0.25, cap: 1 } });
  await actAs(alice);
  await fixturePackage({ streak: { step: 0.5, cap: 2 } }, "2026-10-12");
  await attend(["2026-09-28", "2026-10-12"]);
  assert.equal(Number((await score("2026-10-19")).points), 15);
  await attend(["2026-10-05"]);
  const row = await score("2026-10-19");
  assert.equal(Number(row.points), 40); // 15 + 25, old week retains old rules.
  assert.equal(Number(row.settled_multiplier), 2.5);
});

test("legacy scoring is preserved before cutover, including streak continuation from earlier months", async () => {
  await db.exec("reset role; update public.ranking_settings set cutover='2026-11-02'");
  await attend(["2026-09-30", "2026-10-02", "2026-10-04", "2026-10-05"]);
  const row = await score("2026-10-05");
  assert.equal(Number(row.points), 45);
  assert.equal(Number(row.current_streak), 4);
  assert.equal(Number(row.multiplier), 1.75);
});

test("DST/year boundaries and cross-month weeks use Rome dates and original-month attribution", async () => {
  await fixturePackage({ count: { days: 2, bonus: 1 } });
  await attend(["2026-10-24", "2026-10-25", "2026-12-28", "2027-01-03"]);
  assert.equal(Number((await score("2026-10-26")).points), 40);
  assert.equal(Number((await score("2027-01-03")).points), 10);
  assert.equal(Number((await score("2027-01-04")).points), 20);
  await actAs(alice);
  await db.query("select public.submit_gym_day($1,$2,'2026-03-28T23:30:00Z')", [alice, randomUUID()]);
  await db.query("select public.submit_gym_day($1,$2,'2026-03-28T23:30:00Z')", [alice, randomUUID()]);
  assert.equal((await db.query("select * from public.gym_attendance where gym_date='2026-03-29'")).rows.length, 1);
  await db.exec("reset role");
  const previousMonth = (await db.query("select * from public.ranking_scores('2027-01-04','2026-12-01') where user_id=$1", [alice])).rows[0];
  assert.equal(Number(previousMonth.points), 20);
  assert.equal(Number(previousMonth.gym_days), 1);
});

test("an unfinished empty week preserves the previous sequence until its deadline", async () => {
  await fixturePackage({ streak: { step: 0.25, cap: 1 } });
  await attend(["2026-10-05", "2026-10-12"]);
  const current = await score("2026-10-19");
  assert.equal(Number(current.weekly_streak), 2);
  assert.equal(Number(current.pending_bonus), 0);
  assert.equal(Number((await score("2026-10-26")).weekly_streak), 0);
});

test("strict majority generalizes beyond three members and duplicate last votes do not create extra approvals", async () => {
  await db.exec("reset role");
  await db.query("insert into public.friend_members(user_id,display_name) values ($1,'Fourth')", [outsider]);
  await actAs(alice);
  const id = await propose();
  await actAs(bob);
  assert.equal(await vote(id), "pending");
  await actAs(cara);
  assert.deepEqual(await Promise.all([vote(id), vote(id)]), ["approved", "approved"]);
  await actAs(outsider);
  await assert.rejects(vote(id), /no longer pending/);
  assert.equal((await snapshot()).proposals[0].votes.length, 2);
});

test("migration cutover is the next Monday; historical month RPC cannot control settlement time", async () => {
  await db.exec("reset role");
  const calendar = (await db.query(`select date_trunc('week', now() at time zone 'Europe/Rome')::date as monday`)).rows[0].monday;
  await db.query("update public.ranking_settings set cutover=$1::date + 7", [calendar]);
  await actAs(alice);
  const data = await snapshot();
  const expected = new Date(calendar);
  expected.setUTCDate(expected.getUTCDate() + 7);
  assert.equal(data.cutover, expected.toISOString().slice(0, 10));
  await assert.rejects(db.query("select * from public.friends_leaderboard('2026-10-02')"), /Invalid ranking month/);
  await assert.rejects(db.query("select * from public.friends_leaderboard('infinity')"), /Invalid ranking month/);
  await assert.rejects(db.query("select * from public.friends_leaderboard('2999-01-01')"), /Invalid ranking month/);
});

async function browser(t, user = alice) {
  const dom = new JSDOM("<main></main>", { url: "https://example.test/workout/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  const state = { user, calls: [], callback: null, error: null, beforeRpc: null };
  w.console.error = () => {};
  for (const name of ["state", "attendance", "social", "ui", "tab-workout", "tab-leaderboard"]) {
    w.eval(await readFile(new URL(`../assets/${name}.js`, import.meta.url), "utf8"));
  }
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.user ? { user: { id: state.user } } : null }, error: null }),
      onAuthStateChange: (callback) => { state.callback = callback; },
    },
    from: () => {
      let id = state.user;
      const chain = {
        select: () => chain, eq: (_field, value) => { id = value; return chain; },
        maybeSingle: async () => {
          await actAs(state.user);
          return { data: (await db.query("select user_id,display_name from public.friend_members where user_id=$1", [id])).rows[0] || null, error: null };
        },
      };
      return chain;
    },
    rpc: async (name, args = {}) => {
      const rpcUser = state.user;
      state.calls.push({ name, args });
      if (state.beforeRpc) await state.beforeRpc(name, args);
      if (state.error) return { data: null, error: new Error(state.error) };
      await actAs(rpcUser);
      try {
        if (name === "friends_leaderboard") {
          const rows = (await db.query("select * from public.friends_leaderboard()")).rows;
          return { data: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
            [key, value instanceof Date ? value.toISOString().slice(0, 10) : value]))), error: null };
        }
        if (name === "ranking_objectives") return { data: await snapshot(), error: null };
        if (name === "propose_ranking_objectives") return { data: await propose(args.p_rules, args.p_id), error: null };
        if (name === "vote_ranking_objectives") return { data: await vote(args.p_id, args.p_approve), error: null };
        if (name === "withdraw_ranking_objectives") {
          return { data: (await db.query("select public.withdraw_ranking_objectives($1) as status", [args.p_id])).rows[0].status, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      } catch (error) { return { data: null, error }; }
    },
  };
  w.WORKOUT_SOCIAL_CONFIG = { url: "https://example.test", publishableKey: "test-only" };
  w.loadSupabaseClient = async () => ({ createClient: () => client });
  await w.workoutSocial.init();
  const root = w.document.querySelector("main");
  const cleanup = w.renderLeaderboard(root);
  t.after(cleanup);
  async function settle() {
    for (let i = 0; i < 100 && w.workoutSocial.snapshot().busy; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(w.workoutSocial.snapshot().busy, false);
  }
  await settle();
  const click = (label, parent = root) => {
    const button = [...parent.querySelectorAll("button")].find((item) => item.textContent === label);
    assert.ok(button, `Missing button: ${label}`);
    assert.equal(button.disabled, false);
    button.click();
  };
  return { w, state, root, settle, click };
}

test("real database UI proposes objectives with Aura previews, prevents self-voting, and withdraws", async (t) => {
  const { w, state, root, settle, click } = await browser(t);
  assert.equal(w.workoutSocial.snapshot().objectivesError, "");
  assert.match(root.textContent, /Aura Pts/);
  const form = root.querySelector(".objective-form");
  const enable = form.querySelector('[name="enable-count"]');
  enable.checked = true;
  enable.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.match(form.textContent, /45 Punti Aura/);
  form.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  let proposal = w.workoutSocial.snapshot().objectives.proposals[0];
  assert.deepEqual(JSON.parse(JSON.stringify(proposal.rules)), { count: { days: 3, bonus: 0.5 } });
  assert.equal(root.querySelector('[data-proposal-id] button').textContent, "Ritira proposta");
  assert.equal([...root.querySelectorAll("button")].some((button) => button.textContent === "Approva"), false);
  assert.equal(root.querySelector(".objective-form button").disabled, true);
  assert.equal(state.calls.filter((c) => c.name === "propose_ranking_objectives").length, 1);
  click("Ritira proposta");
  await settle();
  proposal = w.workoutSocial.snapshot().objectives.proposals[0];
  assert.equal(proposal.status, "withdrawn");
  assert.equal(root.querySelector(".objective-form button").disabled, false);
});

test("real database UI votes as both friends, shows scheduled activation and escapes member names", async (t) => {
  const id = await propose();
  await db.exec("reset role");
  await db.query("update public.friend_members set display_name='<img src=x onerror=alert(1)>' where user_id=$1", [alice]);
  const first = await browser(t, bob);
  assert.equal(first.root.querySelector("img"), null);
  first.click("Approva");
  await first.settle();
  assert.equal(first.w.workoutSocial.snapshot().objectives.proposals[0].status, "pending");
  assert.match(first.root.textContent, /1\/2 approvazioni/);
  assert.equal(first.root.querySelector(`[data-proposal-id="${id}"] button`), null);
  const second = await browser(t, cara);
  second.click("Approva");
  await second.settle();
  const approved = second.w.workoutSocial.snapshot().objectives.proposals[0];
  assert.equal(approved.status, "approved");
  assert.match(second.root.textContent, /Approvato, dal/);
  assert.match(second.root.textContent, new RegExp(approved.effective_from));
});

test("active objective cards show count and weekday progress separately from settled Aura earnings", async (t) => {
  const week = (await snapshot()).week_start;
  await fixturePackage(rules, week);
  await attend([week]);
  const { root, w } = await browser(t);
  assert.match(root.textContent, /Frequenza: 1\/3 giorni/);
  assert.match(root.textContent, /mancano Sabato, Domenica/);
  assert.match(root.textContent, /tetto \+1×/);
  const own = w.workoutSocial.snapshot().rows.find((row) => row.user_id === alice);
  assert.equal(Number(own.points), 10);
  assert.equal(Number(own.pending_bonus), 2.5);
  assert.equal(Number(own.settled_multiplier), 1);
});

test("objective UI validation, rejection, offline errors, and server failures remain explicit", async (t) => {
  const { w, state, root, settle, click } = await browser(t);
  const form = root.querySelector(".objective-form");
  form.dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.match(root.textContent, /Seleziona almeno un obiettivo/);
  assert.equal(state.calls.some((c) => c.name === "propose_ranking_objectives"), false);
  const enabled = form.querySelector('[name="enable-schedule"]');
  enabled.checked = true;
  enabled.dispatchEvent(new w.Event("input", { bubbles: true }));
  form.dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.match(root.textContent, /Seleziona almeno un giorno/);
  form.querySelector('[name="schedule-days"]').checked = true;
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  form.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  assert.match(root.textContent, /Sei offline/);
  assert.equal(state.calls.some((c) => c.name === "propose_ranking_objectives"), false);
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  state.error = "Service unavailable";
  form.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  assert.match(root.textContent, /Service unavailable/);
  const attemptedId = state.calls.find((c) => c.name === "propose_ranking_objectives").args.p_id;
  state.error = null;
  form.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(w.workoutSocial.snapshot().objectives.proposals[0].id, attemptedId);
  const friend = await browser(t, bob);
  friend.click("Rifiuta");
  await friend.settle();
  assert.equal(friend.w.workoutSocial.snapshot().objectives.proposals[0].status, "rejected");
  assert.match(friend.root.textContent, /Respinta/);
  click("Aggiorna / riprova");
  await settle();
  assert.equal(root.querySelector(".objective-form button").disabled, false);
});

test("objective fetch failures preserve workouts/access and disable stale voting until refreshed", async (t) => {
  await propose();
  const { w, state, root, settle } = await browser(t, bob);
  state.beforeRpc = async (name) => {
    if (name === "ranking_objectives") throw new Error("Goals unavailable");
  };
  await w.workoutSocial.refresh();
  assert.ok(w.workoutSocial.snapshot().member);
  assert.equal(w.workoutSocial.snapshot().accessReady, true);
  assert.match(w.workoutSocial.snapshot().objectivesError, /Goals unavailable/);
  assert.equal(root.querySelector('[data-proposal-id] button').disabled, true);
  state.beforeRpc = null;
  await w.workoutSocial.refresh();
  await settle();
  assert.equal(w.workoutSocial.snapshot().objectivesError, "");
  assert.equal(root.querySelector('[data-proposal-id] button').disabled, false);
});

test("identity changes discard old objective responses, draft values, and operation feedback", async (t) => {
  const { w, state, root, settle } = await browser(t);
  const enabled = root.querySelector('[name="enable-count"]');
  enabled.checked = true;
  enabled.dispatchEvent(new w.Event("input", { bubbles: true }));
  let release;
  let started;
  const waitStarted = new Promise((resolve) => { started = resolve; });
  state.beforeRpc = async (name) => {
    if (name === "propose_ranking_objectives") {
      started();
      await new Promise((resolve) => { release = resolve; });
    }
  };
  root.querySelector(".objective-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await waitStarted;
  state.user = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  assert.equal(w.workoutSocial.snapshot().objectives, null);
  assert.equal(root.querySelector(".ranking-objectives").hidden, true);
  release();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await settle();
  assert.equal(root.querySelector('[name="enable-count"]').checked, false);
  assert.equal(root.querySelector(".ranking-objectives > .social-status").textContent, "");
});
