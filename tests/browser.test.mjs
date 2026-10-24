import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const sources = {};
for (const file of ["state", "attendance", "social", "social-config", "ui", "tab-workout", "tab-leaderboard", "tab-progress", "tab-profile", "workout-library", "plan-editor", "plan-validation", "tab-plan", "tab-day", "auth-entry", "app"]) {
  sources[file] = await readFile(new URL(`../assets/${file}.js`, import.meta.url), "utf8");
}
const plan = {
  warmup: [{ id: "warm", name: "Warmup", target: "1 min" }],
  sessions: [
    { id: "standard", label: "Giorno 1", type: "standard", exercises: [
      { id: "squat", name: "Squat", target: "5", sets: 1, optionalSets: 1 },
    ] },
    { id: "amrap", label: "Giorno 2", type: "amrap", duration: "1 min", exercises: [] },
  ],
};
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(t, { configured = false, signedIn = true, approved = true } = {}) {
  const dom = new JSDOM("<main id='workout-app'></main>", {
    url: "https://example.github.io/workout/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.scrollTo = () => {};
  const errors = [];
  w.console.error = (...args) => errors.push(args);
  for (const file of ["state", "attendance", "social", "ui", "tab-workout", "tab-leaderboard"]) w.eval(sources[file]);
  const state = { id: signedIn ? alice : null, approved, rpcError: null, authError: null, calls: [], callback: null };
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: { session: state.id ? { user: { id: state.id } } : null }, error: state.authError,
      }),
      onAuthStateChange: (callback) => { state.callback = callback; },
      signInWithPassword: async (args) => {
        state.login = args;
        if (!state.authError) state.id = alice;
        return { data: { session: { user: { id: state.id } } }, error: state.authError };
      },
      signOut: async () => {
        if (!state.authError) state.id = null;
        return { error: state.authError };
      },
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: (updates) => { state.name = updates.display_name; return chain; },
        single: async () => ({ data: { user_id: state.id, display_name: state.name }, error: null }),
        maybeSingle: async () => ({
          data: state.approved ? { user_id: state.id, display_name: state.name || "Alice" } : null,
          error: state.membershipError,
        }),
      };
      return chain;
    },
    rpc: async (name, args) => {
      state.calls.push({ name, args });
      if (state.beforeRpc) await state.beforeRpc(name, args);
      if (name === "ranking_objectives") return {
        data: { cutover: "2026-10-26", week_start: "2026-10-19", settles_on: "2026-10-26", proposals: [] },
        error: state.rpcError,
      };
      if (name === "submit_gym_day" && args.p_user_id !== state.id) {
        return { data: null, error: { code: "42501", message: "Membership required" } };
      }
      return {
        error: state.rpcError,
        data: name === "friends_leaderboard" ? [{
          user_id: state.id, display_name: state.name || "<img src=x onerror=alert(1)>",
          points: 12.5, gym_days: 1, current_streak: 2, multiplier: 1.25,
          position: 1, month_start: "2026-10-01",
        }] : "2026-10-21",
      };
    },
  };
  w.WORKOUT_SOCIAL_CONFIG = configured ? { url: "https://example.supabase.co", publishableKey: "public" } : {};
  w.loadSupabaseClient = async () => ({ createClient: () => fakeClient });
  w.testPlan = structuredClone(plan);
  return { w, state, errors, container: w.document.querySelector("main") };
}

function finish(w, id = "standard", skipOptional = true) {
  w.eval(`
    for (const step of getWorkoutSteps(testPlan, testPlan.sessions.find(s => s.id === "${id}"))) {
      applyWorkoutProgress(testPlan, "${id}", () => {
        if (step.type === "amrap") updateAmrap("${id}", { completed: true });
        setStepStatus("${id}", step.key, step.optional && ${skipOptional} ? "skipped" : "completed");
      });
    }
  `);
}

test("unconfigured social features do not interfere with workout completion", async (t) => {
  const { w, container } = setup(t);
  await w.workoutSocial.init();
  finish(w);
  const cleanup = w.renderWorkout(container, plan, () => {});
  assert.match(container.textContent, /Ottimo lavoro/);
  assert.match(container.textContent, /Non conteggiato/);
  assert.equal(w.pendingAttendance(alice).length, 0);
  cleanup();
  w.renderLeaderboard(container);
  assert.match(container.textContent, /non configurata/);
  assert.equal(container.querySelector('input[type="email"]'), null);
});

test("strict completion creates one durable user-bound receipt; undo, reload, render and reset behave correctly", async (t) => {
  const { w } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  finish(w);
  assert.equal(w.pendingAttendance(alice).length, 1);
  const original = w.pendingAttendance(alice)[0];
  assert.ok(original.completedAt);
  const cleanup = w.renderWorkout(w.document.querySelector("main"), plan, () => {});
  cleanup();
  w.eval(sources.attendance);
  w.eval(`undoLastStep("standard")`);
  w.eval(`applyWorkoutProgress(testPlan, "standard", () => setStepStatus("standard", "squat:1", "skipped"))`);
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.equal(w.pendingAttendance(alice)[0].id, original.id);
  w.clearProgress("standard");
  finish(w, "standard", false);
  assert.equal(w.pendingAttendance(alice).length, 2);
  assert.notEqual(w.pendingAttendance(alice)[1].id, original.id);
  assert.equal(w.getProgress("standard").steps["squat:1"], "completed");
});

test("a skipped required step is never credited; finishing AMRAP is credited", async (t) => {
  const { w } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  w.eval(`setStepStatus("standard", "warmup:warm", "skipped")`);
  w.eval(`applyWorkoutProgress(testPlan, "standard", () => {
    setStepStatus("standard", "squat:0", "completed");
    setStepStatus("standard", "squat:1", "skipped");
  })`);
  assert.equal(w.pendingAttendance(alice).length, 0);
  finish(w, "amrap");
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.equal(w.getProgress("amrap").amrap.completed, true);
});

test("legacy completed progress is preserved and never backfilled after undo/recomplete", async (t) => {
  const { w } = setup(t, { configured: true });
  await w.workoutSocial.init();
  w.localStorage.setItem("workout.progress", JSON.stringify({
    version: 2, sessions: { standard: {
      steps: { "warmup:warm": "completed", "squat:0": "completed", "squat:1": "skipped" },
      history: ["warmup:warm", "squat:0", "squat:1"],
    } },
  }));
  w.initializeAttendanceRuns(plan);
  assert.equal(w.getProgress("standard").legacyCompletion, true);
  w.undoLastStep("standard");
  w.eval(`applyWorkoutProgress(testPlan, "standard", () => setStepStatus("standard", "squat:1", "completed"))`);
  assert.equal(w.pendingAttendance(alice).length, 0);
  assert.equal(w.getSessionSummary(plan, plan.sessions[0]).complete, true);
});

test("old v1 progress migrates and partial legacy progress can earn a new completion", async (t) => {
  const { w } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  w.localStorage.setItem("workout.progress", JSON.stringify({
    sessionId: "standard", checked: { "warmup:warm": true },
  }));
  w.initializeAttendanceRuns(plan);
  assert.equal(w.getProgress("standard").steps["warmup:warm"], "completed");
  finish(w);
  assert.equal(w.pendingAttendance(alice).length, 1);
});

test("offline events retain timestamps, failed sync stays pending, retry succeeds", async (t) => {
  const { w, state } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  finish(w);
  const receipt = w.pendingAttendance(alice)[0];
  assert.equal(state.calls.filter((call) => call.name === "submit_gym_day").length, 0);
  state.rpcError = new Error("Network lost");
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.match(w.workoutSocial.snapshot().error, /restano in attesa/);
  state.rpcError = null;
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 0);
  const submission = state.calls.find((call) => call.name === "submit_gym_day");
  assert.equal(submission.args.p_completed_at, receipt.completedAt);
  assert.equal(submission.args.p_event_id, receipt.id);
  assert.equal(submission.args.p_user_id, alice);
});

test("account switching never uploads another account's queue and expired auth preserves it", async (t) => {
  const { w, state } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  finish(w);
  state.id = bob;
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.equal(state.calls.filter((call) => call.name === "submit_gym_day").length, 0);
  state.id = alice;
  state.authError = new Error("Session expired");
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.match(w.workoutSocial.snapshot().error, /Session expired/);
});

test("unapproved and signed-out workouts are not silently credited to a later account", async (t) => {
  const { w, state } = setup(t, { configured: true, approved: false });
  await w.workoutSocial.init();
  finish(w);
  state.approved = true;
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 0);
  assert.equal(state.calls.filter((call) => call.name === "submit_gym_day").length, 0);
});

test("leaderboard escapes display names, shows fractional scores, and supports password reauthentication", async (t) => {
  const { w, state, container } = setup(t, { configured: true });
  await w.workoutSocial.init();
  const cleanup = w.renderLeaderboard(container);
  await tick();
  assert.equal(container.querySelectorAll("img").length, 0);
  assert.match(container.textContent, /<img src=x/);
  assert.match(container.textContent, /12,5/);
  assert.match(container.textContent, /1,25/);
  await w.workoutSocial.saveName("Test Friend");
  assert.equal(w.workoutSocial.snapshot().member.display_name, "Test Friend");
  await w.workoutSocial.signOut();
  await w.workoutSocial.signIn("friend@example.com", "my password");
  assert.equal(state.login.email, "friend@example.com");
  assert.equal(state.login.password, "my password");
  assert.equal(w.workoutSocial.snapshot().user.id, alice);
  cleanup();
});

test("invalid auth callbacks and corrupt local storage show explicit errors", async (t) => {
  const { w, container, errors } = setup(t, { configured: true });
  w.location.hash = "error=access_denied&error_description=Link+expired";
  await w.workoutSocial.init();
  assert.match(w.workoutSocial.snapshot().error, /Link expired/);
  assert.equal(w.location.hash, "");
  w.localStorage.setItem("workout.attendance.bad", "{broken");
  assert.throws(() => w.pendingAttendance(alice));
  w.workoutSocial.recordCompletion("run");
  assert.match(w.workoutSocial.snapshot().error, /non salvata/);
  w.renderLeaderboard(container);
  assert.ok(errors.length > 0);
  assert.ok(container.querySelector(".social-status").classList.contains("error"));
  assert.ok(container.querySelector(".social-status").textContent);
});

test("actual workout buttons capture optional skips and AMRAP completion without manual check-in", async (t) => {
  const { w, container } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  let cleanup = w.renderWorkout(container, plan, () => {});
  const click = (label) => [...container.querySelectorAll("button")].find((button) => button.textContent === label).click();
  click("Riscaldamento completato");
  const reps = container.querySelector('[data-actual-field="reps"]');
  reps.value = "5";
  reps.dispatchEvent(new w.Event("input", { bubbles: true }));
  click("Serie completata");
  click("Salta");
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.match(container.textContent, /in attesa/);
  click("Indietro");
  assert.equal(container.querySelector("[data-complete-set]").disabled, true);
  click("Salta");
  assert.equal(w.pendingAttendance(alice).length, 1);
  cleanup();
  w.setCurrentSessionId("amrap");
  w.updateAmrap("amrap", { remainingMilliseconds: 0 });
  w.setStepStatus("amrap", "warmup:warm", "completed");
  cleanup = w.renderWorkout(container, plan, () => {});
  click("Completa AMRAP");
  assert.equal(w.pendingAttendance(alice).length, 2);
  cleanup();
});

test("boot defaults to the daily Plan and Progress works without social config", async (t) => {
  const { w, container } = setup(t);
  w.document.body.insertAdjacentHTML("beforeend",
    '<div id="loading"></div><nav class="app-nav"><button data-view="plan"></button><button data-view="workout"></button><button data-view="profile"></button></nav>');
  w.loadPlan = async () => structuredClone(plan);
  for (const file of ["plan-validation", "workout-library", "tab-plan", "tab-day", "tab-progress", "tab-profile", "plan-editor", "auth-entry"]) w.eval(sources[file]);
  w.eval(sources.app);
  await tick();
  assert.match(container.textContent, /Riscaldamento/);
  assert.match(container.textContent, /Piano di esempio, in sola lettura/);
  assert.match(container.textContent, /creare o modificare.*account approvato/);
  assert.equal(w.getActiveView(), "plan");
  assert.equal(w.document.querySelectorAll(".app-nav button").length, 3);
  assert.equal(container.querySelector('[aria-pressed="true"]').textContent, "Oggi");
  w.document.querySelector('[data-view="profile"]').click();
  assert.match(container.textContent, /Classifica non configurata/);
  assert.match(container.textContent, /Progressi su questo dispositivo/);
  assert.equal(w.getActiveView(), "profile");
});

test("new completions created during a sync are flushed without needing another reconnect", async (t) => {
  const { w, state } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  finish(w);
  let added = false;
  state.beforeRpc = async (name) => {
    if (name === "submit_gym_day" && !added) {
      added = true;
      w.clearProgress("standard");
      finish(w);
    }
  };
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 0);
  assert.equal(state.calls.filter((call) => call.name === "submit_gym_day").length, 2);
});

test("identity changes during submission cannot acknowledge or credit another user's event", async (t) => {
  const { w, state } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  finish(w);
  state.beforeRpc = async (name) => {
    if (name === "submit_gym_day") {
      state.id = bob;
      state.callback("SIGNED_IN", { user: { id: bob } });
    }
  };
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.match(w.workoutSocial.snapshot().error, /Membership required/);
});

test("one invalid event stays pending without blocking a later valid completion", async (t) => {
  const { w, state } = setup(t, { configured: true });
  await w.workoutSocial.init();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  finish(w);
  const invalidId = w.pendingAttendance(alice)[0].id;
  w.clearProgress("standard");
  finish(w);
  state.beforeRpc = async (name, args) => {
    if (name === "submit_gym_day") {
      state.rpcError = args.p_event_id === invalidId
        ? { code: "22023", message: "Invalid completion timestamp or event ID" } : null;
    }
  };
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 1);
  assert.equal(w.pendingAttendance(alice)[0].id, invalidId);
  assert.match(w.workoutSocial.snapshot().error, /Invalid completion/);
});

test("failed sign-out keeps the originating account visible for retry but stops crediting", async (t) => {
  const { w, state } = setup(t, { configured: true });
  await w.workoutSocial.init();
  state.authError = new Error("Sign-out failed");
  await w.workoutSocial.signOut();
  assert.equal(w.workoutSocial.snapshot().user.id, alice);
  assert.equal(w.workoutSocial.snapshot().member, null);
  assert.match(w.workoutSocial.snapshot().error, /Uscita non riuscita/);
  finish(w);
  assert.equal(w.pendingAttendance(alice).length, 0);
});

test("backend outage cannot break boot, workout jumps, or an already-running rest timer", async (t) => {
  const { w, state, container } = setup(t, { configured: true });
  state.membershipError = new Error("Backend unavailable");
  await w.workoutSocial.init();
  assert.match(w.workoutSocial.snapshot().error, /Backend unavailable/);
  const cleanup = w.renderWorkout(container, plan, () => {});
  const select = container.querySelector('[aria-label="Vai a un esercizio"]');
  select.value = "squat:0";
  select.dispatchEvent(new w.Event("change"));
  assert.equal(w.getProgress("standard").steps["warmup:warm"], "completed");
  assert.match(container.textContent, /Squat/);
  const deadline = Date.now() + 60000;
  w.updateRestTimer("standard", { durationSeconds: 60, remainingMilliseconds: 60000, deadline });
  w.dispatchEvent(new w.Event("workout-social-change"));
  assert.equal(w.getProgress("standard").restTimer.deadline, deadline);
  cleanup();
});

test("configured Supabase project supports password sign-in without redirect configuration", async (t) => {
  const { w, state } = setup(t, { signedIn: false });
  w.eval(sources["social-config"]);
  assert.equal(w.WORKOUT_SOCIAL_CONFIG.url, "https://fqwmphxzcuelbfjdpznh.supabase.co");
  assert.match(w.WORKOUT_SOCIAL_CONFIG.publishableKey, /^sb_publishable_/);
  assert.equal(w.WORKOUT_SOCIAL_CONFIG.publishableKey.includes("\\"), false);
  await w.workoutSocial.init();
  assert.equal(w.workoutSocial.snapshot().configured, true);
  await w.workoutSocial.signIn("friend@example.com", "my password");
  assert.equal(w.WORKOUT_SOCIAL_CONFIG.redirectUrl, undefined);
  assert.equal(state.login.email, "friend@example.com");
  assert.equal(state.login.password, "my password");
  assert.equal(w.location.href, "https://example.github.io/workout/");
});
