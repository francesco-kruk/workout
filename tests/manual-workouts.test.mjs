import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";

const files = ["state", "attendance", "ui", "social", "manual-workouts", "tab-workout"];
const sources = await Promise.all(files.map((name) => readFile(new URL(`../assets/${name}.js`, import.meta.url), "utf8")));
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const planTemplate = {
  warmup: [{ id: "warm", name: "Warmup", target: "5 min" }],
  sessions: [
    { id: "strength", label: "Forza", type: "standard", exercises: [{ id: "squat", name: "Squat", sets: 2, target: "5" }] },
    { id: "circuit", label: "Circuito", type: "amrap", duration: "1 min", exercises: [] },
  ],
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("UI did not reach expected state");
}

async function setup(t, plan = structuredClone(planTemplate)) {
  const dom = new JSDOM("<main></main>", { url: "https://example.test", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.console.error = () => {};
  sources.forEach((source) => w.eval(source));
  const record = { id: randomUUID(), user_id: alice, definition: plan };
  const state = { user: alice, record, calls: [], submissions: new Map(), reviewRows: [], beforeRpc: null, failAfterSubmit: false };
  w.workoutLibrary = {
    snapshot: () => ({ record: state.record, plan: state.record.definition }),
    identityChanged: (id) => w.setWorkoutScope(id, record.id),
    load: async () => {},
  };
  const row = (args) => ({
    id: args.p_id, user_id: alice, display_name: "Alice", description: args.p_description,
    replaces_planned: args.p_replaces_planned, completed_at: new Date().toISOString(),
    status: "pending", decided_at: null, reason: null, voters: 2, required_approvals: 2,
    approvals: 0, rejections: 0, own_vote: null, eligible: false,
  });
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: state.user } } } }),
      onAuthStateChange: (callback) => { state.callback = callback; },
    },
    from: () => {
      const chain = { select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: { user_id: state.user, display_name: "Alice" } }) };
      return chain;
    },
    rpc: async (name, args) => {
      state.calls.push({ name, args });
      if (state.beforeRpc) await state.beforeRpc(name, args);
      if (name === "submit_manual_workout") {
        if (!state.submissions.has(args.p_id)) state.submissions.set(args.p_id, row(args));
        if (state.failAfterSubmit) throw new Error("Connection lost after server saved the request");
        return { data: structuredClone(state.submissions.get(args.p_id)) };
      }
      if (name === "manual_workout_activity") {
        return { data: structuredClone(args.p_own
          ? [...state.submissions.values()] : state.reviewRows) };
      }
      if (name === "vote_manual_workout") {
        const target = state.reviewRows.find((item) => item.id === args.p_id);
        target.own_vote = args.p_approve;
        target.status = args.p_approve ? "approved" : "rejected";
        target[args.p_approve ? "approvals" : "rejections"] += 1;
        target.decided_at = new Date().toISOString();
        return { data: structuredClone(target) };
      }
      if (name === "friends_leaderboard") return { data: [] };
      if (name === "workout_previous") return { data: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  w.WORKOUT_SOCIAL_CONFIG = { url: "https://example.test", publishableKey: "public" };
  w.loadSupabaseClient = async () => ({ createClient: () => client });
  await w.workoutSocial.init();
  w.clearProgress("strength");
  const app = w.document.querySelector("main");
  const render = () => w.renderWorkout(app, plan, () => {});
  const form = (choice = "replace", text = "Corsa al parco: 5 km in 30 minuti") => {
    const element = app.querySelector("[data-manual-workout]");
    assert.ok(element);
    assert.equal(element.closest("details").hidden, false);
    element.querySelector("textarea").value = text;
    element.querySelector("select").value = choice;
    return element;
  };
  const submit = (element) => element.dispatchEvent(new w.Event("submit", { cancelable: true }));
  const retainIntent = (sessionId, replacesPlanned = true) => {
    const intent = {
      id: randomUUID(), planVersionId: record.id, sessionId,
      runId: w.getProgress(sessionId).runId, description: "Run 5 km", replacesPlanned,
    };
    w.localStorage.setItem(`workout.manualIntent:${alice}:${record.id}`, JSON.stringify(intent));
    return intent;
  };
  return { w, state, plan, app, render, form, submit, row, retainIntent };
}

const manualVisible = (app) => Boolean(app.querySelector(".manual-workout:not([hidden])"));
const button = (app, label) => {
  const target = [...app.querySelectorAll("button")].find((item) => item.textContent === label);
  assert.ok(target, label);
  return target;
};
const input = (w, element, value) => {
  element.value = value;
  element.dispatchEvent(new w.Event("input", { bubbles: true }));
};

test("manual option hides on first warmup completion and returns after undo, including remount", async (t) => {
  const { w, app, render } = await setup(t);
  let cleanup = render();
  assert.equal(manualVisible(app), true);
  button(app, "Riscaldamento completato").click();
  assert.equal(manualVisible(app), false);
  cleanup();
  cleanup = render();
  assert.equal(manualVisible(app), false);
  button(app, "Indietro").click();
  assert.equal(manualVisible(app), true);
  cleanup();
});

test("no-warmup results hide the option immediately without replacing focused inputs or the manual draft", async (t) => {
  const plan = structuredClone(planTemplate);
  plan.warmup = [];
  plan.sessions[0].exercises[0].usesWeight = true;
  const { w, app, render, form } = await setup(t, plan);
  const cleanup = render();
  const draft = form("extra", "Manual draft");
  const reps = app.querySelector('[data-actual-field="reps"]');
  const weight = app.querySelector('[data-actual-field="weightKg"]');
  const notes = app.querySelector("[data-set-notes]");
  reps.focus();
  input(w, reps, "0");
  assert.equal(manualVisible(app), false);
  assert.equal(w.document.activeElement, reps);
  input(w, reps, "");
  assert.equal(manualVisible(app), true);
  assert.equal(draft.querySelector("textarea").value, "Manual draft");
  input(w, weight, "0");
  assert.equal(manualVisible(app), false);
  input(w, weight, "");
  input(w, notes, "Reduced range");
  assert.equal(manualVisible(app), false);
  input(w, notes, " ");
  assert.equal(manualVisible(app), true);
  input(w, notes, "");
  input(w, reps, "5");
  input(w, weight, "0");
  button(app, "Serie completata").click();
  assert.equal(manualVisible(app), false);
  button(app, "Indietro").click();
  assert.equal(manualVisible(app), false);
  input(w, app.querySelector('[data-actual-field="reps"]'), "");
  input(w, app.querySelector('[data-actual-field="weightKg"]'), "");
  assert.equal(manualVisible(app), true);
  cleanup();
});

test("exercise timer activity hides the option through pause and remount until reset", async (t) => {
  const plan = structuredClone(planTemplate);
  plan.warmup = [];
  Object.assign(plan.sessions[0].exercises[0], { measurementMode: "seconds", target: "20 secondi" });
  const { w, app, render } = await setup(t, plan);
  let cleanup = render();
  const duration = app.querySelector(".exercise-timer input");
  input(w, duration, "30");
  assert.equal(manualVisible(app), true);
  button(app, "Avvia timer").click();
  assert.equal(manualVisible(app), false);
  button(app, "Pausa").click();
  assert.equal(manualVisible(app), false);
  cleanup();
  cleanup = render();
  assert.equal(manualVisible(app), false);
  button(app, "Azzera timer").click();
  assert.equal(manualVisible(app), true);
  cleanup();
});

test("AMRAP start hides immediately, pause and remount retain activity, reset restores availability", async (t) => {
  const plan = structuredClone(planTemplate);
  plan.warmup = [];
  const { w, app, render } = await setup(t, plan);
  w.setCurrentSessionId("circuit");
  w.clearProgress("circuit");
  let cleanup = render();
  assert.equal(manualVisible(app), true);
  button(app, "Avvia timer").click();
  assert.equal(manualVisible(app), false);
  assert.equal(w.getProgress("circuit").amrap.remainingMilliseconds, 60000);
  button(app, "Pausa").click();
  assert.equal(manualVisible(app), false);
  cleanup();
  cleanup = render();
  assert.equal(manualVisible(app), false);
  button(app, "Reset").click();
  assert.equal(manualVisible(app), true);
  button(app, "+").click();
  assert.equal(manualVisible(app), false);
  button(app, "−").click();
  assert.equal(manualVisible(app), true);
  const extra = app.querySelector('[data-actual-field="extraReps"]');
  input(w, extra, "0");
  assert.equal(manualVisible(app), false);
  input(w, extra, "");
  assert.equal(manualVisible(app), true);
  input(w, extra, "3");
  button(app, "Reset").click();
  assert.equal(manualVisible(app), true);
  cleanup();
  cleanup = render();
  assert.equal(manualVisible(app), true);
  cleanup();
});

test("activity detection ignores unrelated and empty state but recognizes jumps, rest, and AMRAP completion", async (t) => {
  const { w, plan } = await setup(t);
  const session = plan.sessions[0];
  const activity = () => w.hasPlannedWorkoutActivity(plan, session);
  w.setStepStatus("circuit", "warmup:warm", "completed");
  w.setStepStatus("strength", "removed:0", "completed");
  w.updateSetResult("strength", "removed:0", { reps: "5" });
  w.updateSetResult("strength", "squat:0", { mode: "reps", reps: "", notes: " " });
  assert.equal(activity(), false);
  w.completeStepsBefore(plan, "strength", "squat:1");
  assert.equal(activity(), true);
  w.undoLastStep("strength");
  assert.equal(activity(), true);
  w.undoLastStep("strength");
  assert.equal(activity(), false);
  w.updateRestTimer("strength", { durationSeconds: 60, remainingMilliseconds: 60000, deadline: null });
  assert.equal(activity(), true);
  w.clearRestTimer("strength");
  assert.equal(activity(), false);
  w.clearProgress("circuit");
  w.updateAmrap("circuit", { completed: true });
  assert.equal(w.hasPlannedWorkoutActivity(plan, plan.sessions[1]), true);
});

test("first no-warmup set completion hides the option without requiring stored measurements", async (t) => {
  const plan = structuredClone(planTemplate);
  plan.warmup = [];
  const { w, app, render } = await setup(t, plan);
  w.setStepStatus("strength", "squat:0", "completed");
  const cleanup = render();
  assert.equal(manualVisible(app), false);
  button(app, "Indietro").click();
  assert.equal(manualVisible(app), true);
  cleanup();
});

test("AMRAP start storage errors are explicit and do not start the timer", async (t) => {
  const plan = structuredClone(planTemplate);
  plan.warmup = [];
  const { w, app, render } = await setup(t, plan);
  w.setCurrentSessionId("circuit");
  w.clearProgress("circuit");
  const cleanup = render();
  const setItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key.startsWith("workout.progress:")) throw new Error("Storage full");
    return setItem.call(this, key, value);
  };
  button(app, "Avvia timer").click();
  assert.match(app.textContent, /Timer AMRAP non salvato. Storage full/);
  assert.equal(manualVisible(app), true);
  assert.equal(w.getProgress("circuit").amrap.remainingMilliseconds, null);
  assert.equal(button(app, "Avvia timer").disabled, false);
  w.Storage.prototype.setItem = setItem;
  button(app, "Avvia timer").click();
  assert.equal(manualVisible(app), false);
  cleanup();
});

test("stale manual forms cannot create new submissions after planned activity begins", async (t) => {
  const { w, app, state, render, form, submit } = await setup(t);
  const cleanup = render();
  const stale = form();
  w.setStepStatus("strength", "warmup:warm", "completed");
  submit(stale);
  await until(() => /pianificato già iniziato/.test(app.textContent));
  assert.equal(state.submissions.size, 0);
  assert.equal(state.calls.some((call) => call.name === "submit_manual_workout"), false);
  assert.equal(w.localStorage.getItem(`workout.manualIntent:${alice}:${state.record.id}`), null);
  cleanup();
});

test("retained failed submissions remain recoverable after planned activity starts", async (t) => {
  const { w, app, state, plan, render, form, submit } = await setup(t);
  state.failAfterSubmit = true;
  let cleanup = render();
  submit(form());
  await until(() => /Connection lost/.test(app.textContent));
  const id = [...state.submissions.keys()][0];
  button(app, "Riscaldamento completato").click();
  assert.equal(manualVisible(app), true);
  assert.equal(app.querySelector("textarea").disabled, true);
  cleanup();
  cleanup = render();
  assert.equal(manualVisible(app), true);
  state.failAfterSubmit = false;
  submit(app.querySelector("[data-manual-workout]"));
  await until(() => w.getCurrentSessionId(plan) === "circuit");
  assert.equal(state.submissions.size, 1);
  assert.ok(state.calls.filter((call) => call.name === "submit_manual_workout").every((call) => call.args.p_id === id));
  assert.equal(manualVisible(app), true);
  cleanup();
});

test("recovered replacement advances without fabricated completion and extra preserves partial progress", async (t) => {
  const { w, app, plan, state, render, form, submit, retainIntent } = await setup(t);
  retainIntent("strength", false);
  w.setStepStatus("strength", "warmup:warm", "completed");
  w.updateSetResult("strength", "squat:0", { mode: "reps", reps: "4" });
  const original = plain(w.getProgress("strength"));
  let cleanup = render();
  submit(form("extra"));
  await until(() => /Allenamento inviato/.test(app.textContent));
  assert.equal(w.getCurrentSessionId(plan), "strength");
  assert.deepEqual(plain(w.getProgress("strength")), original);
  assert.equal(state.calls.filter((call) => call.name === "submit_workout_result" || call.name === "submit_gym_day").length, 0);
  cleanup();
  retainIntent("strength");
  cleanup = render();
  submit(form("replace"));
  await until(() => w.getCurrentSessionId(plan) === "circuit");
  assert.equal(w.getSessionSummary(plan, plan.sessions[0]).complete, false);
  assert.deepEqual(plain(w.getProgress("circuit").steps), {});
  assert.equal(state.submissions.size, 2);
  const lastIntent = state.calls.filter((call) => call.name === "submit_manual_workout").at(-1).args;
  assert.equal(lastIntent.p_replaces_planned, true);
  assert.equal("p_completed_at" in lastIntent, false);
  // A rejection affects ranking, never the chosen local progression.
  [...state.submissions.values()].at(-1).status = "rejected";
  assert.equal(w.getCurrentSessionId(plan), "circuit");
  cleanup();
});

test("ambiguous network failure retries one immutable ID/time, including after remount", async (t) => {
  const { w, app, plan, state, render, form, submit } = await setup(t);
  state.failAfterSubmit = true;
  let cleanup = render();
  submit(form());
  await until(() => /Connection lost/.test(app.textContent));
  assert.equal(w.getCurrentSessionId(plan), "strength");
  assert.equal(state.submissions.size, 1);
  const initial = [...state.submissions.values()][0];
  assert.equal(app.querySelector("textarea").disabled, true);
  cleanup();
  cleanup = render();
  const recovered = app.querySelector("[data-manual-workout]");
  assert.equal(recovered.querySelector("textarea").value, initial.description);
  state.failAfterSubmit = false;
  submit(recovered);
  await until(() => w.getCurrentSessionId(plan) === "circuit");
  const calls = state.calls.filter((call) => call.name === "submit_manual_workout");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.p_id, calls[1].args.p_id);
  assert.equal([...state.submissions.values()][0].completed_at, initial.completed_at);
  assert.equal(state.submissions.size, 1);
  assert.equal([...Array(w.localStorage.length)].map((_, i) => w.localStorage.key(i)).some((key) => key.startsWith("workout.manualIntent:")), false);
  cleanup();
});

test("duplicate submits, blank descriptions, omitted choices and offline submission cannot advance", async (t) => {
  const { w, state, app, plan, render, form, submit } = await setup(t);
  const cleanup = render();
  const target = form("", " ");
  submit(target);
  assert.equal(state.submissions.size, 0);
  target.querySelector("select").value = "extra";
  submit(target);
  assert.equal(state.submissions.size, 0);
  target.querySelector("textarea").value = "Run 5 km";
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  submit(target);
  await until(() => /Torna online/.test(app.textContent));
  assert.equal(state.submissions.size, 0);
  assert.equal(w.getCurrentSessionId(plan), "strength");
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  state.beforeRpc = () => gate;
  submit(target);
  submit(target);
  assert.equal(state.calls.filter((call) => call.name === "submit_manual_workout").length, 1);
  release();
  await until(() => state.submissions.size === 1 && /Allenamento inviato/.test(app.textContent));
  cleanup();
});

test("progression retry marker is atomic and a single-day replacement starts a fresh run", async (t) => {
  const single = structuredClone(planTemplate);
  single.sessions = [single.sessions[0]];
  const { w, state, plan, app, render, form, submit } = await setup(t, single);
  const runId = w.getProgress("strength").runId;
  const cleanup = render();
  submit(form());
  await until(() => /Allenamento inviato/.test(app.textContent));
  assert.equal(w.getCurrentSessionId(plan), "strength");
  assert.notEqual(w.getProgress("strength").runId, runId);
  const nextRun = w.getProgress("strength").runId;
  w.applyManualWorkoutProgress(plan, {
    id: [...state.submissions.keys()][0], sessionId: "strength", runId, replacesPlanned: true,
  });
  assert.equal(w.getProgress("strength").runId, nextRun);
  cleanup();
});

test("session and identity changes during submission do not mutate another session/account", async (t) => {
  const { w, state, plan, app, render, form, submit } = await setup(t);
  let cleanup = render();
  let release;
  state.beforeRpc = (name) => name === "submit_manual_workout" ? new Promise((resolve) => { release = resolve; }) : null;
  submit(form());
  w.setCurrentSessionId("circuit");
  w.clearProgress("circuit");
  const before = plain(w.getProgress("circuit"));
  release();
  await until(() => /giornata è cambiata/.test(app.textContent));
  assert.deepEqual(plain(w.getProgress("circuit")), before);
  w.setCurrentSessionId("strength");
  cleanup();
  cleanup = render();
  submit(form());
  state.user = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  release();
  await until(() => /Account cambiato/.test(app.textContent));
  assert.equal(w.getCurrentSessionId(plan), "strength");
  assert.deepEqual(plain(w.readProgressStore()), { version: 2, sessions: {} });
  cleanup();
});

test("switching plan during submission preserves the new plan and leaves original intent recoverable", async (t) => {
  const { w, state, app, render, form, submit } = await setup(t);
  const cleanup = render();
  let release;
  state.beforeRpc = () => new Promise((resolve) => { release = resolve; });
  submit(form());
  const originalVersion = state.record.id;
  state.record = { ...state.record, id: randomUUID() };
  w.setWorkoutScope(alice, state.record.id);
  release();
  await until(() => /Richiesta inviata/.test(app.textContent));
  assert.deepEqual(plain(w.readProgressStore()), { version: 2, sessions: {} });
  assert.ok(w.localStorage.getItem(`workout.manualIntent:${alice}:${originalVersion}`));
  cleanup();
});

test("replacing an active AMRAP stops its timer before resetting the next run", async (t) => {
  const single = structuredClone(planTemplate);
  single.sessions = [single.sessions[1]];
  const { w, plan, app, render, form, submit, retainIntent } = await setup(t, single);
  w.clearProgress("circuit");
  retainIntent("circuit");
  w.setStepStatus("circuit", "warmup:warm", "completed");
  let live = 0;
  const setInterval = w.setInterval.bind(w);
  const clearInterval = w.clearInterval.bind(w);
  w.setInterval = (...args) => { live += 1; return setInterval(...args); };
  w.clearInterval = (id) => { live -= 1; clearInterval(id); };
  const cleanup = render();
  [...app.querySelectorAll("button")].find((button) => button.textContent === "Avvia timer").click();
  assert.equal(live, 1);
  submit(form());
  await until(() => /Allenamento inviato/.test(app.textContent));
  assert.equal(live, 0);
  assert.equal(w.getProgress("circuit").amrap.remainingMilliseconds, null);
  assert.equal(w.getSessionSummary(plan, plan.sessions[0]).complete, false);
  cleanup();
});

test("manual replacement and extra submissions clear the exercise timer without changing actual results", async (t) => {
  for (const choice of ["extra", "replace"]) {
    const timed = structuredClone(planTemplate);
    Object.assign(timed.sessions[0].exercises[0], { measurementMode: "seconds", target: "20 secondi" });
    const { w, app, render, form, submit, retainIntent } = await setup(t, timed);
    retainIntent("strength", choice === "replace");
    w.setStepStatus("strength", "warmup:warm", "completed");
    w.updateSetResult("strength", "squat:0", { seconds: "12" });
    const intervals = new Map();
    w.setInterval = (callback) => { intervals.set(1, callback); return 1; };
    w.clearInterval = (id) => intervals.delete(id);
    const cleanup = render();
    app.querySelector(".exercise-timer button").click();
    assert.equal(intervals.size, 1);
    assert.ok(w.getProgress("strength").exerciseTimer);
    submit(form(choice));
    await until(() => /Allenamento inviato/.test(app.textContent));
    assert.equal(intervals.size, 0);
    assert.equal(w.getProgress("strength").exerciseTimer, null);
    assert.equal(w.getProgress("strength").results["squat:0"].seconds, "12");
    assert.equal(w.getCurrentSessionId(timed), choice === "replace" ? "circuit" : "strength");
    cleanup();
  }
});

test("review UI renders shared text safely, votes once and refreshes ranking", async (t) => {
  const { w, app, state, row } = await setup(t);
  const pending = row({ p_id: randomUUID(), p_description: "<img src=x onerror=alert(1)>", p_replaces_planned: false });
  Object.assign(pending, { user_id: bob, display_name: "<script>bad</script>", eligible: true, approvals: 1 });
  state.reviewRows.push(pending);
  const cleanup = w.renderManualWorkouts(app);
  await until(() => app.querySelector(".manual-review"));
  assert.equal(app.querySelector("img, script"), null);
  assert.match(app.textContent, /<img src=x/);
  const approve = [...app.querySelectorAll("button")].find((button) => button.textContent === "Approva");
  approve.click();
  approve.click();
  await until(() => /Voto salvato/.test(app.textContent));
  assert.equal(state.calls.filter((call) => call.name === "vote_manual_workout").length, 1);
  assert.equal(state.calls.at(-1).name, "friends_leaderboard");
  assert.match(app.textContent, /Approvato/);
  assert.match(app.textContent, /Il tuo voto: approva/);
  assert.equal([...app.querySelectorAll("button")].some((button) => button.textContent === "Rifiuta"), false);
  cleanup();
});

test("review loads, failures, pagination, offline errors and cleanup are explicit", async (t) => {
  const { w, app, state, row } = await setup(t);
  state.reviewRows = Array.from({ length: 20 }, () => ({
    ...row({ p_id: randomUUID(), p_description: "Home workout", p_replaces_planned: true }),
    user_id: bob, eligible: true,
  }));
  const cleanup = w.renderManualWorkouts(app);
  await until(() => /Carica precedenti/.test(app.textContent));
  const more = [...app.querySelectorAll("button")].find((button) => button.textContent.startsWith("Carica precedenti"));
  more.click();
  await until(() => state.calls.filter((call) => call.name === "manual_workout_activity").length === 3);
  await tick();
  const call = state.calls.filter((call) => call.name === "manual_workout_activity").at(-1);
  assert.equal(call.args.p_before_id, state.reviewRows.at(-1).id);
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  [...app.querySelectorAll("button")].find((button) => button.textContent === "Aggiorna revisioni").click();
  await until(() => /Torna online/.test(app.textContent));
  assert.equal(app.querySelectorAll(".manual-review").length, 20);
  cleanup();
  const before = app.textContent;
  w.dispatchEvent(new w.Event("workout-social-change"));
  assert.equal(app.textContent, before);
});

test("a failed local progression write retains the submitted request and can be recovered once", async (t) => {
  const { w, state, app, plan, render, form, submit } = await setup(t);
  let cleanup = render();
  const setItem = w.Storage.prototype.setItem;
  let failed = false;
  w.Storage.prototype.setItem = function (key, value) {
    if (!failed && key.startsWith("workout.progress:")) {
      failed = true;
      throw new Error("Storage full");
    }
    return setItem.call(this, key, value);
  };
  submit(form());
  await until(() => /Storage full/.test(app.textContent));
  assert.equal(state.submissions.size, 1);
  assert.equal(w.getCurrentSessionId(plan), "strength");
  assert.equal(Object.keys(w.readProgressStore().manualApplied || {}).length, 0);
  cleanup();
  cleanup = render();
  submit(app.querySelector("[data-manual-workout]"));
  await until(() => w.getCurrentSessionId(plan) === "circuit");
  assert.equal(state.submissions.size, 1);
  assert.equal(Object.keys(w.readProgressStore().manualApplied).length, 1);
  cleanup();
});

test("a submission resolving after navigation stops the newly mounted timer and refreshes that workout", async (t) => {
  const single = structuredClone(planTemplate);
  single.sessions = [single.sessions[1]];
  const { w, state, app, render, form, submit, retainIntent } = await setup(t, single);
  w.clearProgress("circuit");
  retainIntent("circuit");
  w.setStepStatus("circuit", "warmup:warm", "completed");
  let cleanup = render();
  let release;
  state.beforeRpc = (name) => name === "submit_manual_workout" ? new Promise((resolve) => { release = resolve; }) : null;
  submit(form());
  cleanup();
  cleanup = render();
  [...app.querySelectorAll("button")].find((button) => button.textContent === "Avvia timer").click();
  release();
  await until(() => /Allenamento inviato/.test(app.textContent));
  assert.equal(w.getProgress("circuit").amrap.remainingMilliseconds, null);
  assert.deepEqual(plain(w.getProgress("circuit").steps), {});
  assert.match(app.textContent, /Riscaldamento 1/);
  cleanup();
});

test("vote failures are explicit and lock retries to the same immutable vote", async (t) => {
  const { w, state, app, row } = await setup(t);
  state.reviewRows = [{
    ...row({ p_id: randomUUID(), p_description: "Run", p_replaces_planned: true }),
    user_id: bob, eligible: true,
  }];
  const cleanup = w.renderManualWorkouts(app);
  await until(() => app.querySelector(".manual-review"));
  let failing = true;
  state.beforeRpc = (name) => {
    if (name === "vote_manual_workout" && failing) throw new Error("Network unavailable");
  };
  const button = (text) => [...app.querySelectorAll("button")].find((element) => element.textContent === text);
  button("Rifiuta").click();
  await until(() => /Voto non confermato/.test(app.textContent));
  assert.equal(button("Approva").disabled, true);
  assert.equal(button("Rifiuta").disabled, false);
  failing = false;
  button("Rifiuta").click();
  await until(() => /Voto salvato/.test(app.textContent));
  assert.match(app.textContent, /Il tuo voto: rifiuta/);
  assert.ok(state.calls.filter((call) => call.name === "vote_manual_workout").every((call) => call.args.p_approve === false));
  cleanup();
});

test("late review responses cannot reveal a previous account and local mode does not request reviews", async (t) => {
  const { w, app, state } = await setup(t);
  const releases = [];
  state.beforeRpc = (name) => name === "manual_workout_activity"
    ? new Promise((resolve) => releases.push(resolve)) : null;
  const cleanup = w.renderManualWorkouts(app);
  state.user = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  releases.forEach((release) => release());
  await tick();
  assert.equal(app.textContent, "");
  cleanup();
  const snapshot = w.workoutSocial.snapshot;
  w.workoutSocial.snapshot = () => ({ user: null, member: null });
  const count = state.calls.length;
  const cleanupLocal = w.renderManualWorkouts(app);
  await tick();
  assert.equal(state.calls.length, count);
  assert.match(app.textContent, /richiedono l'accesso al gruppo/);
  cleanupLocal();
  w.workoutSocial.snapshot = snapshot;
});
