import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script src="assets\/([^"]+)"><\/script>/g)].map((match) => match[1]);
const source = new Map(await Promise.all(scripts.map(async (file) =>
  [file, await readFile(new URL(`../assets/${file}`, import.meta.url), "utf8")])));
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const definition = {
  version: 2, title: "Scheda personale",
  warmup: [{ id: "warm", name: "Mobilità", target: "5 minuti", instructions: "" }],
  sessions: [
    { id: "strength", label: "Forza", type: "standard", exercises: [
      { id: "squat", name: "Squat", sets: 2, optionalSets: 1, target: "5 ripetizioni", rest: 60, measurementMode: "reps", usesWeight: true },
    ] },
    { id: "circuit", label: "Circuito", type: "amrap", duration: "1 min", exercises: [
      { id: "push", name: "Piegamenti", target: "10 ripetizioni" },
    ] },
  ],
};
const record = (userId, title) => ({
  id: randomUUID(), user_id: userId, revision: 1, created_at: "2026-01-01T00:00:00Z",
  definition: { ...structuredClone(definition), title },
});

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Application did not reach the expected state");
}

async function mount(t, {
  plans = new Map(), storage = {}, planError = null, templateError = null, signedIn = true,
  approved = true, membershipError = null, beforeBoot = () => {}, beforeSession = null,
  beforeMembership = null, beforePlan = null, beforeTemplate = null, hash = "",
} = {}) {
  const dom = new JSDOM(html, { url: `https://example.github.io/workout/${hash}`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.scrollTo = () => {};
  w.console.error = () => {};
  const state = { id: signedIn ? alice : null, plans, planError, calls: [], history: [], records: new Map(),
    approved, membershipError, beforeSession, beforeMembership, beforePlan, beforeRpc: null, authError: null,
    credentialError: null, beforeAuth: null, authCalls: 0, signupNeedsConfirmation: false, emitAuthEvents: true,
    rows: [], historyError: null, emails: new Map([[alice, "alice@example.test"], [bob, "bob@example.test"]]),
    names: new Map(), updates: [], updateError: null, pendingEmail: null, beforeUpdate: null };
  for (const entry of plans.values()) state.records.set(entry.id, entry);
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  for (const file of scripts.filter((file) => file !== "app.js")) w.eval(source.get(file));
  const authenticate = async (args, creatingAccount) => {
    state.authCalls += 1;
    state[creatingAccount ? "signup" : "login"] = args;
    if (state.beforeAuth) await state.beforeAuth();
    if (state.credentialError) return { data: {}, error: state.credentialError };
    if (creatingAccount && state.signupNeedsConfirmation) {
      return { data: { user: { id: alice }, session: null }, error: null };
    }
    state.id = alice;
    const session = { user: { id: alice, email: state.emails.get(alice) } };
    if (state.emitAuthEvents) state.callback("SIGNED_IN", session);
    return { data: { session }, error: null };
  };
  const client = {
    auth: {
      getSession: async () => {
        if (state.beforeSession) await state.beforeSession();
        return { data: { session: state.id ? { user: { id: state.id, email: state.emails.get(state.id), new_email: state.pendingEmail } } : null }, error: state.authError };
      },
      onAuthStateChange: (callback) => { state.callback = callback; },
      signInWithPassword: (args) => authenticate(args, false),
      signUp: (args) => authenticate(args, true),
      updateUser: async (attributes) => {
        state.updates.push(attributes);
        const id = state.id;
        if (state.beforeUpdate) await state.beforeUpdate();
        if (state.updateError) return { data: null, error: state.updateError };
        if (attributes.email) {
          if (state.requireEmailConfirmation) state.pendingEmail = attributes.email;
          else state.emails.set(id, attributes.email);
        }
        const user = { id, email: state.emails.get(id), new_email: state.pendingEmail };
        if (state.emitAuthEvents && id === state.id) state.callback("USER_UPDATED", { user });
        return { data: { user }, error: null };
      },
      signOut: async () => {
        if (!state.authError) state.id = null;
        return { data: null, error: state.authError };
      },
    },
    from: (table) => {
      let userId = state.id;
      let versionId = null;
      let updates;
      const chain = {
        select: () => chain, order: () => chain, limit: () => chain,
        update: (value) => { updates = value; return chain; },
        single: async () => {
          state.names.set(userId, updates.display_name);
          return { data: { user_id: userId, display_name: updates.display_name }, error: null };
        },
        eq: (field, value) => {
          if (field === "id") versionId = value;
          else if (field === "user_id") userId = value;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "friend_members") {
            if (state.beforeMembership) await state.beforeMembership(userId);
            return { data: state.approved ? { user_id: userId, display_name: state.names.get(userId) || "Amico" } : null, error: state.membershipError };
          }
          if (state.beforePlan) await state.beforePlan(userId, versionId);
          const plan = versionId === null ? plans.get(userId) : state.records.get(versionId);
          return { data: plan?.user_id === userId ? plan : null, error: state.planError };
        },
      };
      return chain;
    },
    rpc: async (name, args) => {
      state.calls.push({ name, args });
      const performance = state.performance;
      const previous = state.previous;
      if (state.beforeRpc) await state.beforeRpc(name, args);
      if (name === "ranking_objectives") return {
        data: { cutover: "2026-10-26", week_start: "2026-10-19", settles_on: "2026-10-26", proposals: [] },
        error: null,
      };
      if (name === "friends_leaderboard") return { data: state.rows, error: null };
      if (name === "workout_performance") return { data: performance || { series: [], results: [], more: false }, error: state.performanceError };
      if (name === "workout_previous") return { data: previous || null, error: state.performanceError };
      if (name === "workout_history") return { data: state.history, error: state.historyError };
      if (name === "manual_workout_activity") return { data: [], error: null };
      if (name === "save_workout_plan") {
        if (args.p_user_id !== state.id) return { error: new Error("Membership required") };
        const previous = plans.get(state.id);
        if ((previous?.id || null) !== args.p_base_version_id) return { error: new Error("Plan changed on another device") };
        const saved = {
          id: args.p_version_id, user_id: state.id, definition: structuredClone(args.p_definition),
          revision: (previous?.revision || 0) + 1, created_at: new Date().toISOString(),
        };
        plans.set(state.id, saved);
        state.records.set(saved.id, saved);
        return { data: saved, error: null };
      }
      if (name === "submit_workout_result") {
        assert.equal(args.p_user_id, state.id);
        const plan = state.records.get(args.p_plan_version_id);
        state.history = [{
          id: args.p_event_id, completed_at: args.p_completed_at,
          plan_version_id: plan.id, revision: plan.revision, plan_title: plan.definition.title,
          warmup: plan.definition.warmup,
          session: plan.definition.sessions.find((session) => session.id === args.p_session_id),
          steps: args.p_steps, amrap_rounds: args.p_amrap_rounds,
          measurements: args.p_measurements, amrap_extra_reps: args.p_amrap_extra_reps,
        }];
      }
      return { data: "2026-10-21", error: null };
    },
  };
  w.loadSupabaseClient = async () => ({ createClient: () => client });
  w.WORKOUT_SOCIAL_CONFIG = { url: "https://example.supabase.co", publishableKey: "public" };
  w.loadPlan = async () => {
    if (beforeTemplate) await beforeTemplate();
    if (templateError) throw templateError;
    return { ...structuredClone(definition), title: "Esempio pubblico" };
  };
  beforeBoot(w, state);
  w.eval(source.get("app.js"));
  await w.workoutSocial.init();
  await until(() => !w.document.querySelector("#loading") && !w.workoutSocial.snapshot().busy);
  return { w, state, app: w.document.querySelector("#workout-app") };
}

function click(w, label) {
  const button = [...w.document.querySelectorAll("button")].find((element) => element.textContent === label);
  assert.ok(button, `Button missing: ${label}`);
  button.click();
}
function navigate(w, view) { w.document.querySelector(`[data-view="${view}"]`).click(); }
function input(w, label, value) {
  const wrapper = [...w.document.querySelectorAll("label")].find((element) => element.firstChild.textContent === label);
  assert.ok(wrapper, `Field missing: ${label}`);
  const element = wrapper.querySelector("input,textarea,select");
  element.value = value;
  element.dispatchEvent(new w.Event("input", { bubbles: true }));
  return element;
}
function snapshotStorage(w) { return Object.fromEntries(Object.keys(w.localStorage).map((key) => [key, w.localStorage.getItem(key)])); }

function completeSet(w) {
  for (const field of w.document.querySelectorAll("[data-actual-field]")) {
    field.value = field.dataset.actualField === "weightKg" ? "20" : "8";
    field.dispatchEvent(new w.Event("input", { bubbles: true }));
  }
  click(w, "Serie completata");
  if (w.document.querySelector(".rest-timer")) click(w, "Salta recupero");
}

function controlWorkoutClock(w) {
  let now = Date.now();
  let nextId = 0;
  const intervals = new Map();
  w.Date.now = () => now;
  w.setInterval = (callback) => { intervals.set(++nextId, callback); return nextId; };
  w.clearInterval = (id) => intervals.delete(id);
  return {
    intervals,
    advance(milliseconds, tick = true) {
      now += milliseconds;
      if (tick) for (const callback of [...intervals.values()]) callback();
    },
  };
}

function fakeAudio(w, { rejectResume = false, rejectPlayback = false } = {}) {
  const calls = { beeps: 0, resumes: 0, disconnected: 0, contexts: 0 };
  w.AudioContext = class {
    constructor() {
      calls.contexts += 1;
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
    }
    async resume() {
      calls.resumes += 1;
      if (rejectResume) throw new Error("Audio bloccato");
      this.state = "running";
    }
    createOscillator() {
      if (rejectPlayback) throw new Error("Riproduzione fallita");
      return {
        frequency: {}, connect() {},
        disconnect() { calls.disconnected += 1; },
        start() { calls.beeps += 1; },
        stop() { this.onended(); },
      };
    }
    createGain() {
      return {
        connect() {}, disconnect() { calls.disconnected += 1; },
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
      };
    }
  };
  return calls;
}

function startRest(w) {
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
}

test("new plans save without warm-up and existing warm-up can be fully removed and restored in a draft", async (t) => {
  const first = await mount(t);
  click(first.w, "Crea scheda");
  input(first.w, "Nome giornata", "Senza riscaldamento");
  input(first.w, "Nome esercizio", "Squat");
  input(first.w, "Obiettivo / ripetizioni", "8-12 ripetizioni");
  input(first.w, "Recupero (secondi)", "0");
  submitForm(first.w, first.app.querySelector(".plan-editor"));
  await until(() => first.w.workoutLibrary.snapshot().record);
  assert.equal(first.state.plans.get(alice).definition.warmup.length, 0);
  navigate(first.w, "workout");
  assert.ok(first.app.querySelector("[data-complete-set]"));
  assert.doesNotMatch(first.app.textContent, /Riscaldamento/);
  navigate(first.w, "plan");
  assert.doesNotMatch(first.app.textContent, /Riscaldamento/);
  click(first.w, "Piano completo");
  assert.doesNotMatch(first.app.textContent, /Riscaldamento/);

  const plans = new Map([[alice, record(alice, "Con riscaldamento")]]);
  const second = await mount(t, { plans });
  click(second.w, "Modifica piano");
  const remove = [...second.app.querySelectorAll("button")].find((button) => button.textContent === "Rimuovi");
  assert.equal(remove.disabled, false);
  remove.click();
  assert.equal(second.w.workoutLibrary.getDraft().definition.warmup.length, 0);
  assert.ok([...second.app.querySelectorAll("button")].filter((button) => button.textContent === "Rimuovi")
    .some((button) => button.disabled));
  const reloaded = await mount(t, { plans, storage: snapshotStorage(second.w) });
  click(reloaded.w, "Riprendi modifica");
  assert.equal(reloaded.w.workoutLibrary.getDraft().definition.warmup.length, 0);
  assert.equal(reloaded.w.workoutLibrary.snapshot().plan.warmup.length, 1);
  click(reloaded.w, "Aggiungi riscaldamento");
  assert.equal(reloaded.w.workoutLibrary.getDraft().definition.warmup.length, 1);
});

test("empty warm-up CSV round-trips and both workout types complete without warm-up", async (t) => {
  const noWarmup = structuredClone(definition);
  noWarmup.warmup = [];
  const { w, app } = await mount(t);
  const file = app.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", { value: [{ name: "plan.csv", size: 500, text: async () => w.exportWorkoutCsv(noWarmup) }] });
  file.dispatchEvent(new w.Event("change"));
  await until(() => app.querySelector(".import-preview"));
  click(w, "Usa CSV come bozza");
  await until(() => app.querySelector(".plan-editor"));
  const circuitId = w.workoutLibrary.getDraft().definition.sessions[1].id;
  let exported;
  w.URL.createObjectURL = (blob) => { exported = blob; return "blob:no-warmup"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  click(w, "Esporta CSV della bozza");
  const reader = new w.FileReader();
  const content = new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
  });
  reader.readAsText(exported);
  assert.equal(w.parseWorkoutCsv(await content).warmup.length, 0);
  submitForm(w, app.querySelector(".plan-editor"));
  await until(() => w.workoutLibrary.snapshot().record);
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  navigate(w, "workout");
  completeSet(w);
  completeSet(w);
  click(w, "Salta");
  assert.ok(app.querySelector(".completion-card"));
  assert.equal(w.pendingAttendance(alice).length, 1);
  click(w, "Passa a Circuito");
  w.updateAmrap(circuitId, { remainingMilliseconds: 0, rounds: 2 });
  navigate(w, "plan");
  navigate(w, "workout");
  click(w, "Completa AMRAP");
  assert.equal(w.pendingAttendance(alice).length, 2);
  for (const receipt of w.pendingAttendance(alice)) {
    assert.ok(Object.keys(receipt.workout.steps).every((key) => !key.startsWith("warmup:")));
  }
});

test("integer inputs give immediate accessible feedback and recover without rounding", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Numeri")]]) });
  click(w, "Modifica piano");
  const sets = input(w, "Serie obbligatorie", "1.5");
  assert.equal(sets.step, "1");
  assert.equal(sets.getAttribute("aria-invalid"), "true");
  assert.match(w.document.getElementById(sets.getAttribute("aria-describedby")).textContent, /numero intero/);
  submitForm(w, app.querySelector(".plan-editor"));
  assert.equal(w.workoutLibrary.snapshot().record.revision, 1);
  input(w, "Serie obbligatorie", "2");
  input(w, "Recupero (secondi)", "0");
  assert.equal(sets.getAttribute("aria-invalid"), "false");
  input(w, "Serie opzionali", "-1");
  assert.equal(app.querySelector(".plan-editor").checkValidity(), false);
  input(w, "Serie opzionali", "0");
  assert.equal(app.querySelector(".plan-editor").checkValidity(), true);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  input(w, "Peso (kg)", "12.25");
  const reps = input(w, "Ripetizioni", "2.5");
  assert.equal(reps.getAttribute("aria-invalid"), "true");
  assert.match(app.querySelector("[data-measurement-error]").textContent, /Ripetizioni.*numero intero/);
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  input(w, "Ripetizioni", "2");
  assert.equal(reps.getAttribute("aria-invalid"), "false");
  assert.equal(app.querySelector("[data-complete-set]").disabled, false);

  Object.defineProperty(reps, "validity", { configurable: true, get: () => ({ valid: false, badInput: true }) });
  reps.value = "";
  reps.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  assert.equal(w.getProgress("strength").results["squat:0"].reps, "invalid");
  delete reps.validity;
  input(w, "Ripetizioni", "0");
  assert.equal(app.querySelector("[data-complete-set]").disabled, false);
});

test("AMRAP extra reps reject invalid whole-number values and permit blank or zero", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "AMRAP")]]) });
  w.setCurrentSessionId("circuit");
  w.setStepStatus("circuit", "warmup:warm", "completed");
  w.updateAmrap("circuit", { remainingMilliseconds: 0, rounds: 2 });
  navigate(w, "workout");
  const complete = [...app.querySelectorAll("button")].find((button) => button.textContent === "Completa AMRAP");
  for (const value of ["1.5", "-1", "100001"]) {
    const extra = input(w, "Ripetizioni extra (facoltative)", value);
    assert.equal(complete.disabled, true);
    assert.equal(extra.getAttribute("aria-invalid"), "true");
    assert.match(app.querySelector("[data-measurement-error]").textContent, /numero intero/);
  }
  for (const value of ["0", ""]) {
    input(w, "Ripetizioni extra (facoltative)", value);
    assert.equal(complete.disabled, false);
  }
});

test("rest beeps once on natural expiry, with no duplicate visibility or interval alert", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Suono")]]) });
  const audio = fakeAudio(w);
  const clock = controlWorkoutClock(w);
  startRest(w);
  await Promise.resolve();
  assert.equal(audio.contexts, 1);
  assert.equal(audio.beeps, 0);
  clock.advance(60000);
  assert.equal(audio.beeps, 1);
  assert.equal(audio.disconnected, 2);
  assert.equal(app.querySelector(".rest-timer"), null);
  Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  clock.advance(60000);
  assert.equal(audio.beeps, 1);
});

test("rest audio respects pause/resume, skip, visibility catch-up, and navigation cleanup", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Ciclo audio")]]) });
  const audio = fakeAudio(w);
  const clock = controlWorkoutClock(w);
  startRest(w);
  await Promise.resolve();
  click(w, "Pausa");
  clock.advance(120000);
  assert.equal(audio.beeps, 0);
  click(w, "Riprendi");
  clock.advance(60000, false);
  Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  assert.equal(audio.beeps, 1);
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  click(w, "Salta recupero");
  assert.equal(audio.beeps, 1);
  click(w, "Indietro");
  click(w, "Serie completata");
  assert.ok(app.querySelector(".rest-timer"));
  navigate(w, "profile");
  clock.advance(60000);
  assert.equal(audio.beeps, 1);
  navigate(w, "workout");
  assert.equal(app.querySelector(".rest-timer"), null);
  assert.equal(audio.beeps, 1);
});

test("Profile mute persists across reload, applies at expiry, and enables audio again", async (t) => {
  const plans = new Map([[alice, record(alice, "Muto")]]);
  const { w, app } = await mount(t, { plans });
  const audio = fakeAudio(w);
  const clock = controlWorkoutClock(w);
  startRest(w);
  await Promise.resolve();
  w.workoutAudio.setMuted(true);
  clock.advance(60000);
  assert.equal(audio.beeps, 0);
  navigate(w, "profile");
  assert.equal(app.querySelector("[data-rest-sound-muted]").checked, true);
  const reloaded = await mount(t, { plans, storage: snapshotStorage(w) });
  const reloadedAudio = fakeAudio(reloaded.w);
  assert.equal(reloaded.app.querySelector("[data-rest-sound-muted]").checked, true);
  reloaded.app.querySelector("[data-rest-sound-muted]").click();
  await Promise.resolve();
  assert.equal(reloaded.w.workoutAudio.muted(), false);
  assert.equal(reloadedAudio.contexts, 1);
  assert.equal(reloaded.w.localStorage.getItem("workout.restSoundMuted"), "false");
  navigate(reloaded.w, "plan");
  navigate(reloaded.w, "profile");
  assert.equal(reloaded.app.querySelector("[data-rest-sound-muted]").checked, false);
});

test("unsupported, blocked, or failed audio stays explicit without stopping rest completion", async (t) => {
  for (const failure of ["unsupported", "resume", "playback"]) {
    const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, failure)]]) });
    if (failure !== "unsupported") fakeAudio(w, { rejectResume: failure === "resume", rejectPlayback: failure === "playback" });
    const clock = controlWorkoutClock(w);
    startRest(w);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(60000);
    assert.equal(w.getProgress("strength").restTimer, null);
    assert.ok(app.querySelector("[data-complete-set]"));
    assert.match(app.querySelector("[data-audio-status]").textContent, /Suono dei timer non disponibile/);
  }
});

test("Profile reports failed preference writes and restores the saved mute state", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Preferenze")]]) });
  navigate(w, "profile");
  const originalSetItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key === "workout.restSoundMuted") throw new Error("Spazio esaurito");
    return originalSetItem.call(this, key, value);
  };
  app.querySelector("[data-rest-sound-muted]").click();
  assert.equal(app.querySelector("[data-rest-sound-muted]").checked, false);
  assert.match(app.textContent, /Preferenza audio non salvata.*Spazio esaurito/);
});

test("Profile reports failed preference reads rather than silently enabling sound", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Preferenze")]]) });
  const originalGetItem = w.Storage.prototype.getItem;
  w.Storage.prototype.getItem = function (key) {
    if (key === "workout.restSoundMuted") throw new Error("Memoria non disponibile");
    return originalGetItem.call(this, key);
  };
  navigate(w, "profile");
  assert.equal(app.querySelector("[data-rest-sound-muted]").disabled, true);
  assert.match(app.textContent, /Preferenza audio non disponibile.*Memoria non disponibile/);
});

test("password sign-in opens the private app in place without storing the password", async (t) => {
  const { w, state, app } = await mount(t, { signedIn: false });
  let release;
  state.beforeAuth = () => new Promise((resolve) => { release = resolve; });
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.equal(w.document.querySelector("#sign-out").hidden, true);
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  assert.doesNotMatch(app.textContent, /Esempio pubblico|Riscaldamento|Classifica/);
  const email = input(w, "Email", "friend@example.com");
  const password = input(w, "Password", " chosen password ");
  assert.equal(email.autocomplete, "username");
  assert.equal(password.type, "password");
  assert.equal(password.autocomplete, "current-password");
  assert.equal(password.hasAttribute("minlength"), false);
  const url = w.location.href;
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.equal(app.querySelector("button[type=submit]").disabled, true);
  assert.equal(email.disabled, true);
  assert.equal(password.disabled, true);
  assert.match(app.textContent, /Accesso in corso/);
  release();
  await until(() => !w.workoutSocial.snapshot().busy && w.workoutSocial.snapshot().accessReady);
  assert.equal(w.location.href, url);
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
  assert.match(app.textContent, /Crea scheda/);
  assert.equal(app.querySelector('input[type="password"]'), null);
  assert.equal(state.login.email, "friend@example.com");
  assert.equal(state.login.password, " chosen password ");
  assert.equal(state.signup, undefined);
  assert.doesNotMatch(JSON.stringify(snapshotStorage(w)), /chosen password/);
  assert.doesNotMatch(JSON.stringify(w.workoutSocial.snapshot()), /chosen password/);
});

test("self-registration signs in without email and keeps private data locked until owner approval", async (t) => {
  const { w, state, app } = await mount(t, { signedIn: false, approved: false });
  let release;
  state.beforeAuth = () => new Promise((resolve) => { release = resolve; });
  input(w, "Email", "new@example.com");
  input(w, "Password", "discard this");
  click(w, "Crea un account");
  assert.equal(app.querySelector("h2").textContent, "Crea un account");
  assert.match(app.textContent, /proprietario deve approvare/);
  const password = input(w, "Password", "my new password");
  assert.equal(password.autocomplete, "new-password");
  assert.equal(password.minLength, 8);
  const url = w.location.href;
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.match(app.textContent, /Registrazione in corso/);
  assert.equal(app.querySelectorAll("button:disabled").length, 2);
  release();
  await until(() => !w.workoutSocial.snapshot().busy && w.workoutSocial.snapshot().accessReady);
  assert.equal(w.location.href, url);
  assert.equal(state.signup.email, "new@example.com");
  assert.equal(state.signup.password, "my new password");
  assert.equal(state.login, undefined);
  assert.match(app.textContent, /Accesso in attesa di approvazione/);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.equal(w.document.querySelector("#sign-out").hidden, false);
  assert.equal(w.workoutLibrary.snapshot().record, null);
  assert.equal(state.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshotStorage(w)), /my new password/);
  state.approved = true;
  click(w, "Aggiorna / riprova");
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(w.getActiveView(), "plan");
  assert.match(app.textContent, /Crea scheda/);
});

test("switching auth modes clears the password and restores password-manager hints", async (t) => {
  const { w, app } = await mount(t, { signedIn: false });
  input(w, "Email", "friend@example.com");
  const password = input(w, "Password", "never reuse this");
  click(w, "Crea un account");
  assert.equal(password.value, "");
  assert.equal(password.autocomplete, "new-password");
  password.value = "another password";
  click(w, "Hai già un account? Accedi");
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  assert.equal(password.value, "");
  assert.equal(password.autocomplete, "current-password");
  assert.equal(password.hasAttribute("minlength"), false);
  assert.equal(app.querySelector('input[type="email"]').value, "friend@example.com");
});

test("wrong credentials show a retryable error and a successful retry restores the existing plan", async (t) => {
  const a = record(alice, "La mia scheda esistente");
  const { w, state, app } = await mount(t, { signedIn: false, plans: new Map([[alice, a]]) });
  state.credentialError = new Error("Invalid login credentials");
  input(w, "Email", "friend@example.com");
  const password = input(w, "Password", "wrong");
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(app.textContent, /Accesso non riuscito.*Invalid login credentials/);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.equal(password.disabled, false);
  assert.equal(app.querySelector("button[type=submit]").disabled, false);
  state.credentialError = null;
  state.emitAuthEvents = false;
  password.value = "right";
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !w.workoutSocial.snapshot().busy && w.workoutSocial.snapshot().accessReady);
  assert.equal(w.workoutLibrary.snapshot().record.id, a.id);
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
});

test("registration errors remain on the form without granting access", async (t) => {
  const { w, state, app } = await mount(t, { signedIn: false, approved: false });
  state.credentialError = new Error("User already registered");
  click(w, "Crea un account");
  input(w, "Email", "existing@example.com");
  input(w, "Password", "my new password");
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(app.textContent, /Registrazione non riuscita.*User already registered/);
  assert.equal(w.workoutSocial.snapshot().user, null);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.equal(app.querySelector("button[type=submit]").disabled, false);
});

test("email-confirmation misconfiguration is an explicit registration error, not approved access", async (t) => {
  const { w, state, app } = await mount(t, { signedIn: false, approved: false });
  state.signupNeedsConfirmation = true;
  click(w, "Crea un account");
  input(w, "Email", "friend@example.com");
  input(w, "Password", "my new password");
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(app.textContent, /disattivare la conferma email/);
  assert.equal(app.querySelector("h2").textContent, "Crea un account");
  assert.equal(w.workoutSocial.snapshot().user, null);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.equal(state.calls.length, 0);
});

test("registration rejects seven-character passwords and accepts the eight-character minimum", async (t) => {
  const { w, state, app } = await mount(t, { signedIn: false, approved: false });
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.equal(state.authCalls, 0);
  await w.workoutSocial.signIn("friend@example.com", "");
  assert.match(app.textContent, /Inserisci email e password/);
  await w.workoutSocial.signUp("friend@example.com", "1234567");
  assert.match(app.textContent, /almeno 8 caratteri/);
  assert.equal(state.authCalls, 0);
  assert.equal(w.workoutSocial.snapshot().busy, false);
  await w.workoutSocial.signUp("friend@example.com", "12345678");
  assert.equal(state.authCalls, 1);
  assert.equal(state.signup.password, "12345678");
  assert.match(app.textContent, /Accesso in attesa di approvazione/);
});

test("pending authentication blocks duplicate requests and mode switches", async (t) => {
  const { w, state, app } = await mount(t, { signedIn: false });
  let release;
  state.beforeAuth = () => new Promise((resolve) => { release = resolve; });
  input(w, "Email", "friend@example.com");
  input(w, "Password", "my password");
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  click(w, "Crea un account");
  await w.workoutSocial.signUp("friend@example.com", "my password");
  assert.equal(state.authCalls, 1);
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  release();
  await until(() => !w.workoutSocial.snapshot().busy && w.workoutSocial.snapshot().accessReady);
});

test("session restoration waits for identity, membership and private plan without any example flash", async (t) => {
  const a = record(alice, "Solo Alice");
  let releaseSession, releaseMember, releasePlan;
  const session = new Promise((resolve) => { releaseSession = resolve; });
  const member = new Promise((resolve) => { releaseMember = resolve; });
  const plan = new Promise((resolve) => { releasePlan = resolve; });
  let w, state;
  const mounting = mount(t, {
    plans: new Map([[alice, a]]), beforeSession: () => session, beforeMembership: () => member, beforePlan: () => plan,
    beforeBoot: (window, fixture) => { w = window; state = fixture; },
    storage: { "workout.activeView": "leaderboard" },
  });
  const assertLoading = () => {
    assert.equal(w.document.querySelector(".app-nav").hidden, true);
    assert.match(w.document.querySelector("#workout-app").textContent, /Accesso in corso/);
    assert.doesNotMatch(w.document.querySelector("#workout-app").textContent, /Solo Alice|Esempio pubblico|Punti mensili/);
  };
  assertLoading();
  releaseSession();
  await until(() => Boolean(w.workoutSocial.snapshot().user));
  assertLoading();
  releaseMember();
  await until(() => Boolean(w.workoutSocial.snapshot().member));
  assertLoading();
  releasePlan();
  await mounting;
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
  assert.equal(w.getActiveView(), "profile");
  assert.equal(w.workoutLibrary.snapshot().record.id, a.id);
  assert.equal(w.document.querySelector('.auth-panel input[type="email"]'), null);
  assert.equal(w.document.querySelector("#sign-out").hidden, false);
  assert.ok(state.calls.some((call) => call.name === "friends_leaderboard"));
});

test("private access and sign-in do not wait for a slow public example download", async (t) => {
  let releaseTemplate;
  const template = new Promise((resolve) => { releaseTemplate = resolve; });
  const { w, app } = await mount(t, { signedIn: false, beforeTemplate: () => template });
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  releaseTemplate();
  await until(() => Boolean(w.workoutLibrary.template()));
  assert.equal(app.querySelector("h2").textContent, "Accedi");
});

test("resolved private access opens the app without waiting for leaderboard synchronization", async (t) => {
  const a = record(alice, "Pronta");
  let w, release;
  const slow = new Promise((resolve) => { release = resolve; });
  const mounting = mount(t, {
    plans: new Map([[alice, a]]),
    beforeBoot: (window, state) => {
      w = window;
      state.beforeRpc = () => slow;
    },
  });
  await until(() => w.workoutSocial.snapshot().accessReady);
  assert.equal(w.workoutSocial.snapshot().busy, true);
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
  assert.match(w.document.querySelector("#workout-app").textContent, /Riscaldamento/);
  release();
  await mounting;
});

test("unapproved accounts see only pending access, then enter plan setup after owner approval", async (t) => {
  const { w, state, app } = await mount(t, { approved: false });
  assert.match(app.textContent, /Accesso in attesa di approvazione/);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.equal(w.document.querySelector("#sign-out").hidden, false);
  assert.equal(w.workoutLibrary.snapshot().record, null);
  assert.equal(state.calls.length, 0);
  navigate(w, "workout");
  assert.match(app.textContent, /Accesso in attesa/);
  state.approved = true;
  click(w, "Aggiorna / riprova");
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(w.getActiveView(), "plan");
  assert.match(app.textContent, /Crea scheda/);
  assert.ok(app.querySelector('input[type="file"]'));
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
});

test("access failures cannot open cached plans before membership is verified and can be retried", async (t) => {
  const a = record(alice, "Privato in cache");
  const { w, state, app } = await mount(t, {
    membershipError: new Error("Membership unavailable"), plans: new Map([[alice, a]]),
    storage: { [`workout.personalPlan:${alice}`]: JSON.stringify(a) },
  });
  assert.match(app.textContent, /Impossibile verificare l'accesso/);
  assert.match(app.textContent, /Membership unavailable/);
  assert.doesNotMatch(app.textContent, /Privato in cache|Esempio pubblico/);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  state.membershipError = null;
  click(w, "Aggiorna / riprova");
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(w.workoutLibrary.snapshot().record.id, a.id);
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
});

test("failed initial plan loading is not confused with a first-login missing plan", async (t) => {
  const { w, state, app } = await mount(t, { planError: new Error("Plan unavailable") });
  assert.match(app.textContent, /Impossibile caricare la tua scheda/);
  assert.match(app.textContent, /Plan unavailable/);
  assert.doesNotMatch(app.textContent, /Crea scheda|Esempio pubblico/);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  state.planError = null;
  click(w, "Aggiorna / riprova");
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(w.getActiveView(), "plan");
  assert.match(app.textContent, /Crea scheda/);
});

test("expired legacy email links allow password sign-in instead", async (t) => {
  const { w, state, app } = await mount(t, {
    signedIn: false, hash: "#error=access_denied&error_description=Link+expired",
  });
  assert.equal(w.location.hash, "");
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  assert.match(app.textContent, /Link expired/);
  input(w, "Email", "friend@example.com");
  input(w, "Password", "my password");
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(state.login.email, "friend@example.com");
  assert.equal(state.login.password, "my password");
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
});

test("sign-out from a workout immediately hides private data, stops timers and preserves scoped progress", async (t) => {
  const a = record(alice, "Scheda da nascondere");
  const { w, state, app } = await mount(t, { plans: new Map([[alice, a]]) });
  w.setCurrentSessionId("circuit");
  w.setStepStatus("circuit", "warmup:warm", "completed");
  navigate(w, "workout");
  click(w, "Avvia timer");
  assert.equal(w.document.querySelector("#sign-out"), null);
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy);
  w.document.querySelector("#sign-out").click();
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.doesNotMatch(app.textContent, /Circuito|Scheda da nascondere|Esempio pubblico/);
  await until(() => !w.workoutSocial.snapshot().busy);
  const saved = JSON.parse(w.localStorage.getItem(`workout.progress:${alice}:${a.id}`));
  assert.ok(saved.sessions.circuit.amrap.remainingMilliseconds > 0);
  state.id = alice;
  state.callback("SIGNED_IN", { user: { id: alice } });
  await until(() => w.workoutSocial.snapshot().accessReady);
  navigate(w, "workout");
  assert.ok(w.getProgress("circuit").amrap.remainingMilliseconds > 0);
  assert.match(app.textContent, /Circuito/);
});

test("failed sign-out shows a retryable access error without exposing the previous account's plan", async (t) => {
  const a = record(alice, "Scheda privata");
  const { w, state, app } = await mount(t, { plans: new Map([[alice, a]]) });
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy);
  state.authError = new Error("Sign-out failed");
  click(w, "Esci");
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(app.textContent, /Uscita non riuscita/);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.doesNotMatch(app.textContent, /Scheda privata|Esempio pubblico/);
  assert.equal(w.document.querySelector("#sign-out").hidden, false);
  state.authError = null;
  click(w, "Esci");
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(app.querySelector("h2").textContent, "Accedi");
});

test("an account switch hides the previous plan while the next private plan is loading", async (t) => {
  const a = record(alice, "Scheda Alice");
  const b = record(bob, "Scheda Bob");
  const { w, state, app } = await mount(t, { plans: new Map([[alice, a], [bob, b]]) });
  navigate(w, "plan");
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  state.beforePlan = () => slow;
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  assert.match(app.textContent, /Accesso in corso/);
  assert.doesNotMatch(app.textContent, /Scheda Alice|Esempio pubblico/);
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  await until(() => Boolean(w.workoutSocial.snapshot().member));
  assert.doesNotMatch(app.textContent, /Scheda Alice|Scheda Bob/);
  release();
  await until(() => w.workoutSocial.snapshot().accessReady);
  assert.match(app.textContent, /Scheda Bob/);
  assert.doesNotMatch(app.textContent, /Scheda Alice/);
});

test("refreshing an already-open offline account does not remount or stop its active workout", async (t) => {
  const a = record(alice, "Offline");
  const { w, state, app } = await mount(t, { plans: new Map([[alice, a]]) });
  w.setCurrentSessionId("circuit");
  w.setStepStatus("circuit", "warmup:warm", "completed");
  navigate(w, "workout");
  click(w, "Avvia timer");
  const timer = app.querySelector(".amrap-timer");
  const firstChild = app.firstChild;
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  w.dispatchEvent(new w.Event("offline"));
  state.membershipError = new Error("Offline membership request");
  await w.workoutSocial.refresh();
  assert.equal(app.firstChild, firstChild);
  assert.equal(app.querySelector(".amrap-timer"), timer);
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
  assert.equal([...app.querySelectorAll("button")].find((button) => button.textContent === "Pausa")?.disabled, false);
  assert.match(w.document.querySelector("#account-status").textContent, /Offline membership request/);
});

test("one shared URL loads different private plans, without copying guest progress into either account", async (t) => {
  const a = record(alice, "Scheda Alice");
  const b = record(bob, "Scheda Bob");
  const guest = JSON.stringify({ version: 2, sessions: { strength: { steps: { "warmup:warm": "completed" }, history: [] } } });
  const { w, state } = await mount(t, { plans: new Map([[alice, a], [bob, b]]), storage: { "workout.progress": guest } });
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Scheda Alice");
  const guestAfterBoot = w.localStorage.getItem("workout.progress");
  assert.equal(Object.keys(w.getProgress("strength").steps).length, 0);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  assert.equal(w.getProgress("strength").steps["warmup:warm"], "completed");
  const oldStorage = w.localStorage.getItem(`workout.progress:${alice}:${a.id}`);
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  await until(() => w.workoutLibrary.snapshot().record?.id === b.id);
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Scheda Bob");
  assert.equal(Object.keys(w.getProgress("strength").steps).length, 0);
  await w.workoutSocial.signOut();
  assert.equal(w.workoutLibrary.snapshot().userId, null);
  assert.equal(w.localStorage.getItem("workout.progress"), guestAfterBoot);
  assert.equal(JSON.parse(guestAfterBoot).sessions.strength.steps["warmup:warm"], "completed");
  assert.equal(w.localStorage.getItem(`workout.progress:${alice}:${a.id}`), oldStorage);
});

test("switching accounts stops old AMRAP timers before the storage namespace changes", async (t) => {
  const a = record(alice, "Alice");
  const b = record(bob, "Bob");
  const { w, state } = await mount(t, { plans: new Map([[alice, a], [bob, b]]) });
  w.setCurrentSessionId("circuit");
  w.setStepStatus("circuit", "warmup:warm", "completed");
  navigate(w, "workout");
  click(w, "Avvia timer");
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  await until(() => w.workoutLibrary.snapshot().record?.id === b.id);
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Bob");
  assert.equal(w.getProgress("circuit").amrap.remainingMilliseconds, null);
  const aliceProgress = JSON.parse(w.localStorage.getItem(`workout.progress:${alice}:${a.id}`));
  assert.ok(aliceProgress.sessions.circuit.amrap.remainingMilliseconds > 0);
  state.id = alice;
  state.callback("SIGNED_IN", { user: { id: alice } });
  await until(() => w.workoutLibrary.snapshot().record?.id === a.id);
  assert.ok(w.getProgress("circuit").amrap.remainingMilliseconds > 0);
});

test("first-time member creates a private plan with the editor and can publish without forking", async (t) => {
  const { w, state, app } = await mount(t);
  assert.equal(w.getActiveView(), "plan");
  assert.match(app.textContent, /Non hai ancora una scheda personale/);
  click(w, "Crea scheda");
  input(w, "Titolo della scheda", "La mia nuova scheda");
  assert.equal(w.workoutLibrary.getDraft().definition.warmup.length, 0);
  click(w, "Aggiungi riscaldamento");
  input(w, "Nome", "Mobilità");
  input(w, "Obiettivo", "5 minuti");
  input(w, "Nome giornata", "Giorno A");
  input(w, "Nome esercizio", "Squat");
  input(w, "Obiettivo / ripetizioni", "5 ripetizioni");
  input(w, "Serie obbligatorie", "2");
  input(w, "Recupero (secondi)", "60");
  submitForm(w, w.document.querySelector(".plan-editor"));
  await until(() => w.workoutLibrary.snapshot().record?.revision === 1);
  assert.equal(state.plans.get(alice).definition.title, "La mia nuova scheda");
  assert.equal(w.workoutLibrary.getDraft(), null);
  navigate(w, "workout");
  assert.match(app.textContent, /Giorno A/);
});

test("new plans require numeric rest and nonblank essential fields without requiring optional content", async (t) => {
  const { w, state, app } = await mount(t);
  click(w, "Crea scheda");
  input(w, "Nome giornata", "Giorno A");
  input(w, "Nome esercizio", "Squat");
  input(w, "Obiettivo / ripetizioni", "8-12 ripetizioni");
  const form = app.querySelector(".plan-editor");
  const rest = [...form.querySelectorAll("label")].find((label) => label.firstChild.textContent === "Recupero (secondi)").querySelector("input");
  assert.equal(rest.type, "number");
  assert.equal(rest.required, true);
  assert.equal(rest.step, "1");
  assert.equal(rest.min, "0");
  assert.equal(rest.max, "3600");
  assert.equal(rest.value, "");
  assert.equal(w.workoutLibrary.getDraft().definition.sessions[0].exercises[0].rest, undefined);
  submitForm(w, form);
  assert.equal(state.calls.some((call) => call.name === "save_workout_plan"), false);
  assert.equal(rest.closest(".wizard-panel").hidden, false);
  for (const value of ["", "-1", "1.5", "3601", "60 secondi", "60-90"]) {
    input(w, "Recupero (secondi)", value);
    submitForm(w, form);
    assert.equal(state.calls.some((call) => call.name === "save_workout_plan"), false, value);
    assert.equal(rest.getAttribute("aria-invalid"), "true");
  }
  input(w, "Recupero (secondi)", "0");
  for (const label of ["Titolo della scheda", "Nome giornata", "Nome esercizio", "Obiettivo / ripetizioni"]) {
    const text = input(w, label, "   ");
    submitForm(w, form);
    assert.equal(state.calls.some((call) => call.name === "save_workout_plan"), false);
    assert.equal(text.getAttribute("aria-invalid"), "true");
    input(w, label, label);
  }
  submitForm(w, form);
  await until(() => w.workoutLibrary.snapshot().record);
  const saved = state.plans.get(alice).definition;
  assert.equal(saved.sessions[0].exercises[0].rest, 0);
  assert.equal(typeof saved.sessions[0].exercises[0].rest, "number");
  assert.equal(saved.warmup.length, 0);
  assert.equal(saved.sessions[0].instructions, "");
});

test("AMRAP keeps rest optional but switching to standard requires an explicit rest number", async (t) => {
  const { w, state, app } = await mount(t);
  click(w, "Crea scheda");
  input(w, "Nome giornata", "Circuito");
  input(w, "Nome esercizio", "Piegamenti");
  input(w, "Obiettivo / ripetizioni", "10");
  function changeType(value) {
    const select = [...app.querySelectorAll("label")].find((label) => label.firstChild.textContent === "Tipo di allenamento").querySelector("select");
    select.value = value;
    select.dispatchEvent(new w.Event("change"));
  }
  changeType("amrap");
  assert.equal(app.querySelector('input[min="0"][max="3600"]'), null);
  const duration = input(w, "Durata (es. 20 minuti)", "");
  submitForm(w, app.querySelector("form"));
  assert.equal(state.calls.some((call) => call.name === "save_workout_plan"), false);
  input(w, "Durata (es. 20 minuti)", "20 minuti");
  assert.equal(duration.checkValidity(), true);
  assert.equal(w.validateWorkoutPlan(w.workoutLibrary.getDraft().definition).length, 0);
  changeType("standard");
  const rest = app.querySelector('input[min="0"][max="3600"]');
  assert.equal(rest.value, "");
  assert.equal(rest.required, true);
  submitForm(w, app.querySelector("form"));
  assert.equal(state.calls.some((call) => call.name === "save_workout_plan"), false);
  input(w, "Recupero (secondi)", "90");
  submitForm(w, app.querySelector("form"));
  await until(() => w.workoutLibrary.snapshot().record);
  assert.equal(state.plans.get(alice).definition.sessions[0].exercises[0].rest, 90);
});

test("strict rest validation cannot be bypassed by library saves, imports or invalid remote plans", async (t) => {
  const original = record(alice, "Piano");
  const { w, state, app } = await mount(t, { plans: new Map([[alice, original]]) });
  const invalid = structuredClone(definition);
  invalid.sessions[0].exercises[0].rest = "60 secondi";
  const draft = w.workoutLibrary.writeDraft(invalid);
  await assert.rejects(w.workoutLibrary.save(draft), /recupero obbligatorio/);
  assert.equal(state.calls.some((call) => call.name === "save_workout_plan"), false);
  assert.equal(w.workoutLibrary.getDraft().definition.sessions[0].exercises[0].rest, "60 secondi");
  navigate(w, "profile");
  navigate(w, "plan");
  click(w, "Riprendi modifica");
  const file = app.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", { value: [{ name: "invalid.csv", size: 500, text: async () => w.exportWorkoutCsv(invalid) }] });
  file.dispatchEvent(new w.Event("change"));
  await until(() => app.querySelector(".social-status").textContent.includes("rest_seconds"));
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  const missingRest = record(alice, "Mancante");
  delete missingRest.definition.sessions[0].exercises[0].rest;
  const broken = await mount(t, { plans: new Map([[alice, missingRest]]) });
  assert.equal(broken.w.workoutLibrary.snapshot().record, null);
  assert.match(broken.app.textContent, /Scheda personale non valida/);
});

test("legacy caches and drafts convert ranges to upper bounds while preserving edits and paused timers", async (t) => {
  const original = record(alice, "Intervallo");
  original.definition.sessions[0].exercises[0].rest = "60-90 secondi";
  const cached = structuredClone(original);
  const draft = {
    versionId: "legacy-draft", baseVersionId: original.id,
    definition: { ...structuredClone(original.definition), title: "Bozza modificata" },
  };
  const progress = {
    version: 2, sessions: { strength: {
      runId: "preserved-run", steps: { "warmup:warm": "completed", "squat:0": "completed" },
      history: ["warmup:warm", "squat:0"],
      results: { "squat:0": { mode: "reps", weightKg: "20", reps: "8", notes: "Conservata" } },
      restTimer: { durationSeconds: 75, remainingMilliseconds: 42000, deadline: null },
    } },
  };
  const { w, app } = await mount(t, {
    plans: new Map(), planError: new Error("Offline"),
    storage: {
      [`workout.personalPlan:${alice}`]: JSON.stringify(cached),
      [`workout.planDraft:${alice}`]: JSON.stringify(draft),
      [`workout.progress:${alice}:${original.id}`]: JSON.stringify(progress),
    },
  });
  const clock = controlWorkoutClock(w);
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.workoutLibrary.snapshot().plan.sessions[0].exercises[0].rest, 90);
  assert.match(app.querySelector(".exercise-rest").textContent, /90 secondi/);
  const storedDraft = w.workoutLibrary.getDraft();
  assert.equal(storedDraft.versionId, draft.versionId);
  assert.equal(storedDraft.baseVersionId, original.id);
  assert.equal(storedDraft.definition.title, "Bozza modificata");
  assert.equal(storedDraft.definition.sessions[0].exercises[0].rest, 90);
  const serialized = w.localStorage.getItem(`workout.planDraft:${alice}`);
  w.workoutLibrary.getDraft();
  assert.equal(w.localStorage.getItem(`workout.planDraft:${alice}`), serialized);
  navigate(w, "workout");
  assert.equal(app.querySelector(".timer-value").textContent, "00:42");
  assert.equal(w.getProgress("strength").runId, "preserved-run");
  assert.equal(w.getProgress("strength").results["squat:0"].notes, "Conservata");
  click(w, "Riprendi");
  clock.advance(42000);
  assert.match(app.querySelector(".focus-rest").textContent, /90 secondi/);
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  assert.equal(app.querySelector(".timer-value").textContent, "01:30");
  assert.equal(w.getProgress("strength").restTimer.durationSeconds, 90);
});

test("rest displays app-supplied units in daily, full-plan, workout and historical views including zero", async (t) => {
  for (const rest of [0, 90]) {
    const original = record(alice, "Unità");
    original.definition.sessions[0].exercises[0].rest = rest;
    const { w, state, app } = await mount(t, { plans: new Map([[alice, original]]) });
    const expected = rest === 0 ? "Recupero: 0 secondi (nessun recupero)" : "Recupero: 90 secondi";
    assert.equal(app.querySelector(".exercise-rest").textContent, expected);
    click(w, "Piano completo");
    assert.equal(app.querySelector(".exercise-rest").textContent, expected);
    navigate(w, "workout");
    click(w, "Riscaldamento completato");
    assert.equal(app.querySelector(".focus-rest").textContent, expected.replace("Recupero:", "Recupero dopo la serie:"));
    state.history = [{
      id: "units-history", completed_at: "2026-10-01Z", revision: 1, plan_title: "Unità",
      warmup: definition.warmup, session: original.definition.sessions[0], steps: {},
    }];
    navigate(w, "profile");
    await until(() => app.querySelector(".workout-history .exercise-rest"));
    assert.equal(app.querySelector(".workout-history .exercise-rest").textContent, expected);
  }
});

test("offline editor drafts survive reload; publication creates a new version and leaves old progress intact", async (t) => {
  const original = record(alice, "Prima versione");
  const plans = new Map([[alice, original]]);
  const { w } = await mount(t, { plans });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  navigate(w, "plan");
  click(w, "Modifica piano");
  input(w, "Titolo della scheda", "Seconda versione");
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  submitForm(w, w.document.querySelector(".plan-editor"));
  await until(() => w.document.querySelector(".social-status")?.textContent?.includes("offline")
    || w.document.body.textContent.includes("Torna online"));
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Seconda versione");
  const second = await mount(t, { plans, storage: snapshotStorage(w) });
  navigate(second.w, "plan");
  assert.equal(second.w.document.querySelector(".plan-editor"), null);
  click(second.w, "Riprendi modifica");
  assert.ok(second.w.document.querySelector(".plan-editor"));
  assert.equal(second.w.workoutLibrary.getDraft().definition.title, "Seconda versione");
  submitForm(second.w, second.w.document.querySelector(".plan-editor"));
  await until(() => second.w.workoutLibrary.snapshot().record?.revision === 2);
  assert.equal(Object.keys(second.w.getProgress("strength").steps).length, 0);
  const preserved = JSON.parse(second.w.localStorage.getItem(`workout.progress:${alice}:${original.id}`));
  assert.equal(preserved.sessions.strength.steps["warmup:warm"], "completed");
});

test("validated CSV preview, structural editing and export are available through the UI", async (t) => {
  const { w } = await mount(t);
  navigate(w, "plan");
  const file = w.document.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", { value: [{ name: "plan.csv", size: 500, text: async () => w.exportWorkoutCsv(definition) }] });
  file.dispatchEvent(new w.Event("change"));
  await until(() => Boolean(w.document.querySelector(".import-preview")));
  assert.equal(w.workoutLibrary.getDraft(), null);
  click(w, "Usa CSV come bozza");
  await until(() => Boolean(w.document.querySelector(".plan-editor")));
  assert.equal(w.workoutLibrary.getDraft().definition.title, definition.title);
  assert.equal(w.workoutLibrary.getDraft().definition.sessions[0].exercises[0].measurementMode, "reps");
  assert.equal(w.workoutLibrary.getDraft().definition.sessions[0].exercises[0].usesWeight, true);
  click(w, "Aggiungi riscaldamento");
  click(w, "Aggiungi giornata");
  assert.equal(w.workoutLibrary.getDraft().definition.warmup.length, 2);
  assert.equal(w.workoutLibrary.getDraft().definition.sessions.length, 3);
  const [first, second] = w.workoutLibrary.getDraft().definition.warmup;
  click(w, "Sposta giù");
  assert.equal(w.workoutLibrary.getDraft().definition.warmup[0].id, second.id);
  assert.equal(w.workoutLibrary.getDraft().definition.warmup[1].id, first.id);
  let downloaded = null;
  let exported;
  w.URL.createObjectURL = (blob) => { exported = blob; return "blob:demo"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
  click(w, "Esporta CSV della bozza");
  assert.equal(downloaded, "scheda-allenamento.csv");
  const reader = new w.FileReader();
  const content = new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
  });
  reader.readAsText(exported);
  const exportedCsv = await content;
  assert.match(exportedCsv, /"reps","true"/);
  assert.throws(() => w.parseWorkoutCsv(exportedCsv), /nome|obiettivo|nome|serie|recupero/i);
});

test("JSON uploads are rejected without overwriting an existing personal plan or draft", async (t) => {
  const original = record(alice, "Originale");
  const { w } = await mount(t, { plans: new Map([[alice, original]]) });
  navigate(w, "plan");
  click(w, "Modifica piano");
  const file = w.document.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", { value: [{ name: "plan.json", size: 20, text: async () => '{"version":2}' }] });
  file.dispatchEvent(new w.Event("change"));
  await until(() => w.document.body.textContent.includes("Formato non supportato"));
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Originale");
});

function selectCsv(w, source, { name = "scheda.csv", size = 500, index = 0 } = {}) {
  const file = w.document.querySelectorAll('input[type="file"]')[index];
  assert.ok(file);
  Object.defineProperty(file, "files", { configurable: true, value: [{ name, size, text: typeof source === "function" ? source : async () => source }] });
  file.dispatchEvent(new w.Event("change"));
  return file;
}

test("the creation hub exposes three paths, CSV-only transfers, skill download and a usable agent prompt", async (t) => {
  const { w, app } = await mount(t);
  assert.deepEqual([...app.querySelectorAll(".creation-paths h3")].map((item) => item.textContent), ["Manualmente", "Modello CSV", "Con un agente"]);
  assert.equal(app.querySelector('a[download="SKILL.md"]').getAttribute("href"), "assets/skills/workout-plan/SKILL.md");
  assert.equal(app.querySelectorAll('a[href="data/workout-plan-template.csv"]').length, 2);
  assert.ok([...app.querySelectorAll('input[type="file"]')].every((input) => input.accept === ".csv,text/csv"));
  assert.doesNotMatch(app.textContent, /JSON/);
  let copied;
  Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied = text; } } });
  click(w, "Copia prompt");
  await until(() => app.textContent.includes("Prompt copiato."));
  assert.equal(copied, app.querySelector('textarea[aria-label="Prompt per l\'agente"]').value);
  assert.match(copied, /CSV completo/);
  Object.defineProperty(w.navigator, "clipboard", { value: undefined });
  click(w, "Copia prompt");
  await until(() => app.textContent.includes("Seleziona e copia"));
  assert.ok(app.querySelector(".social-status.error"));
});

test("guided manual entry navigates one exercise at a time and only saves from review", async (t) => {
  const { w, app, state } = await mount(t);
  click(w, "Crea scheda");
  const visible = () => [...app.querySelectorAll(".wizard-panel")].filter((panel) => !panel.hidden);
  assert.equal(visible().length, 1);
  assert.equal(visible()[0].dataset.screen, "details");
  input(w, "Titolo della scheda", "Piano guidato");
  click(w, "Continua alle giornate");
  input(w, "Nome giornata", "Forza");
  click(w, "Modifica esercizio");
  assert.equal(visible()[0].dataset.screen, "exercise");
  input(w, "Nome esercizio", "Squat");
  input(w, "Obiettivo / ripetizioni", "10");
  click(w, "Completa giornata");
  assert.equal(visible()[0].dataset.screen, "exercise");
  input(w, "Recupero (secondi)", "0");
  click(w, "Completa giornata");
  assert.equal(visible()[0].dataset.screen, "days");
  assert.match(visible()[0].textContent, /Squat/);
  assert.equal(state.calls.filter((call) => call.name === "save_workout_plan").length, 0);
  click(w, "Rivedi e continua");
  assert.equal(visible()[0].dataset.screen, "review");
  click(w, "Modifica Squat");
  assert.equal(visible()[0].dataset.screen, "exercise");
  click(w, "3. Rivedi piano");
  click(w, "Salva piano");
  await until(() => w.workoutLibrary.snapshot().record);
  assert.equal(state.plans.get(alice).definition.title, "Piano guidato");
});

test("CSV preview and cancellation preserve the exact existing draft, active plan and progress", async (t) => {
  const original = record(alice, "Originale");
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  navigate(w, "plan");
  click(w, "Modifica piano");
  input(w, "Titolo della scheda", "La mia bozza");
  const before = snapshotStorage(w);
  const candidate = { ...structuredClone(definition), title: "Da CSV" };
  selectCsv(w, w.exportWorkoutCsv(candidate));
  await until(() => app.querySelector(".import-preview"));
  assert.deepEqual(snapshotStorage(w), before);
  assert.match(app.textContent, /bozza “La mia bozza”/);
  click(w, "Annulla importazione");
  assert.deepEqual(snapshotStorage(w), before);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "La mia bozza");
  selectCsv(w, w.exportWorkoutCsv(candidate));
  await until(() => app.querySelector(".import-preview"));
  click(w, "Sostituisci bozza con CSV");
  const draft = w.workoutLibrary.getDraft();
  assert.equal(draft.definition.title, "Da CSV");
  assert.equal(draft.baseVersionId, original.id);
  assert.ok(draft.definition.trackingId);
  assert.notEqual(draft.definition.sessions[0].id, original.definition.sessions[0].id);
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.getProgress("strength").steps["warmup:warm"], "completed");
  assert.equal(app.querySelector('.wizard-panel[data-screen="review"]').hidden, false);
  click(w, "Salva piano");
  await until(() => w.workoutLibrary.snapshot().record.revision === 2);
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Da CSV");
  const progress = JSON.parse(w.localStorage.getItem(`workout.progress:${alice}:${original.id}`));
  assert.equal(progress.sessions.strength.steps["warmup:warm"], "completed");
});

test("invalid CSV and oversized files show errors and can be retried without altering a draft", async (t) => {
  const { w, app } = await mount(t);
  click(w, "Crea scheda");
  const before = w.localStorage.getItem(`workout.planDraft:${alice}`);
  const file = selectCsv(w, "not,a,template");
  await until(() => app.textContent.includes("Intestazioni CSV"));
  assert.match(app.textContent, /Intestazioni CSV/);
  assert.equal(file.value, "");
  assert.equal(w.localStorage.getItem(`workout.planDraft:${alice}`), before);
  selectCsv(w, () => { assert.fail("oversized files must not be read"); }, { size: 800001 });
  await until(() => app.textContent.includes("File troppo grande"));
  assert.equal(w.localStorage.getItem(`workout.planDraft:${alice}`), before);
  selectCsv(w, w.exportWorkoutCsv(definition));
  await until(() => app.querySelector(".import-preview"));
  assert.equal(w.localStorage.getItem(`workout.planDraft:${alice}`), before);
});

test("a stale CSV preview cannot overwrite a newer draft from another editing context", async (t) => {
  const { w, app } = await mount(t);
  selectCsv(w, w.exportWorkoutCsv(definition));
  await until(() => app.querySelector(".import-preview"));
  const newer = w.workoutLibrary.writeDraft({ ...structuredClone(definition), title: "Più recente" });
  click(w, "Usa CSV come bozza");
  assert.match(app.textContent, /La bozza è cambiata/);
  assert.equal(w.workoutLibrary.getDraft().versionId, newer.versionId);
  click(w, "Annulla importazione");
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Più recente");
  assert.equal(app.querySelector(".plan-editor input").value, "Più recente");
});

test("overlapping file selections use only the latest file and navigation cancels pending reads", async (t) => {
  const { w, app } = await mount(t);
  let releaseFirst;
  selectCsv(w, () => new Promise((resolve) => { releaseFirst = resolve; }));
  const latest = { ...structuredClone(definition), title: "Ultimo file" };
  selectCsv(w, w.exportWorkoutCsv(latest), { index: 1 });
  await until(() => app.querySelector(".import-preview"));
  releaseFirst(w.exportWorkoutCsv(definition));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(app.querySelector(".import-preview").textContent, /Ultimo file/);
  click(w, "Annulla importazione");
  click(w, "Crea scheda");
  let release;
  selectCsv(w, () => new Promise((resolve) => { release = resolve; }));
  click(w, "2. Giornate");
  release(w.exportWorkoutCsv(definition));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.querySelector(".import-preview"), null);
  assert.equal(app.querySelector('.wizard-panel[data-screen="days"]').hidden, false);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "La mia scheda");
});

test("draft edits during file reading are preserved instead of replaced by the file", async (t) => {
  const { w, app } = await mount(t);
  click(w, "Crea scheda");
  let release;
  selectCsv(w, () => new Promise((resolve) => { release = resolve; }));
  input(w, "Titolo della scheda", "Modifica durante lettura");
  const version = w.workoutLibrary.getDraft().versionId;
  release(w.exportWorkoutCsv(definition));
  await until(() => app.textContent.includes("La bozza è cambiata durante la lettura"));
  assert.equal(w.workoutLibrary.getDraft().versionId, version);
  assert.equal(app.querySelector(".import-preview"), null);
});

test("a cached personal plan remains usable during a backend outage, with an explicit status", async (t) => {
  const cached = record(alice, "In cache");
  const { w, app } = await mount(t, {
    planError: new Error("Network unavailable"),
    storage: { [`workout.personalPlan:${alice}`]: JSON.stringify(cached) },
  });
  assert.equal(w.workoutLibrary.snapshot().record.id, cached.id);
  assert.match(w.document.querySelector("#account-status").textContent, /Network unavailable/);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  assert.match(app.textContent, /Squat/);
});

test("deleting the newest server version recovers from a newer cache and allows saving again", async (t) => {
  const previous = record(alice, "Scheda rimasta");
  const deleted = { ...record(alice, "Scheda eliminata"), revision: 2 };
  const { w, app } = await mount(t, {
    plans: new Map([[alice, previous]]),
    storage: { [`workout.personalPlan:${alice}`]: JSON.stringify(deleted) },
  });
  assert.equal(w.workoutLibrary.snapshot().record.id, previous.id);
  assert.equal(w.workoutLibrary.snapshot().error, "");
  assert.match(w.document.querySelector("#account-status").textContent, /eliminata dal server/);
  assert.match(app.textContent, /Scheda rimasta/);
  assert.equal(JSON.parse(w.localStorage.getItem(`workout.personalPlan:${alice}`)).id, previous.id);
  const draft = w.workoutLibrary.writeDraft({ ...structuredClone(definition), title: "Salvata dopo recupero" });
  assert.equal(draft.baseVersionId, previous.id);
  await w.workoutLibrary.save(draft);
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Salvata dopo recupero");
  assert.equal(w.workoutLibrary.snapshot().record.revision, 2);
});

test("deleting every server version clears only the plan cache and opens creation", async (t) => {
  const deleted = record(alice, "Scheda eliminata");
  const { w, app } = await mount(t, {
    storage: { [`workout.personalPlan:${alice}`]: JSON.stringify(deleted) },
  });
  assert.equal(w.workoutLibrary.snapshot().record, null);
  assert.equal(w.workoutLibrary.snapshot().error, "");
  assert.equal(w.localStorage.getItem(`workout.personalPlan:${alice}`), null);
  assert.match(w.document.querySelector("#account-status").textContent, /Crea o importa/);
  assert.ok([...app.querySelectorAll("button")].some((button) => button.textContent === "Crea scheda"));
  const draft = w.workoutLibrary.writeDraft(structuredClone(definition));
  assert.equal(draft.baseVersionId, null);
  await w.workoutLibrary.save(draft);
  assert.equal(w.workoutLibrary.snapshot().record.revision, 1);
});

test("deleted active workouts switch automatically without deleting drafts, progress or pending completions", async (t) => {
  const previous = record(alice, "Precedente");
  const deleted = { ...record(alice, "Attiva"), revision: 2 };
  const { w, state } = await mount(t, { plans: new Map([[alice, deleted]]) });
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  completeSet(w);
  completeSet(w);
  click(w, "Salta");
  w.workoutLibrary.writeDraft({ ...structuredClone(definition), title: "Bozza da preservare" });
  const pending = JSON.stringify(w.pendingAttendance(alice));
  assert.equal(w.pendingAttendance(alice).length, 1);
  w.setStepStatus("circuit", "warmup:warm", "completed");
  const before = snapshotStorage(w);
  state.plans.set(alice, previous);
  state.records.delete(deleted.id);
  state.records.set(previous.id, previous);
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutLibrary.load();
  assert.equal(w.workoutLibrary.snapshot().record.id, previous.id);
  assert.equal(w.workoutLibrary.snapshot().availableRecord, null);
  assert.equal(JSON.stringify(w.pendingAttendance(alice)), pending);
  for (const [key, value] of Object.entries(before)) {
    if (key !== `workout.personalPlan:${alice}`) assert.equal(w.localStorage.getItem(key), value, key);
  }
  const draft = w.workoutLibrary.getDraft();
  assert.equal(draft.baseVersionId, deleted.id);
  await assert.rejects(w.workoutLibrary.save(draft), /Plan changed on another device/);
  assert.equal(w.workoutLibrary.getDraft().versionId, draft.versionId);
});

test("deletion recovery clears a previously offered update even when no plans remain", async (t) => {
  const original = record(alice, "Attiva");
  const { w, state } = await mount(t, { plans: new Map([[alice, original]]) });
  w.setStepStatus("strength", "warmup:warm", "completed");
  const latest = { ...record(alice, "Aggiornata"), revision: 2 };
  state.plans.set(alice, latest);
  state.records.set(latest.id, latest);
  await w.workoutLibrary.load();
  assert.equal(w.workoutLibrary.snapshot().availableRecord.id, latest.id);
  state.plans.clear();
  state.records.clear();
  await w.workoutLibrary.load();
  assert.equal(w.workoutLibrary.snapshot().record, null);
  assert.equal(w.workoutLibrary.snapshot().availableRecord, null);
  w.workoutLibrary.useLatest();
  assert.equal(w.workoutLibrary.snapshot().record, null);
});

test("older or missing latest responses cannot replace an active version that still exists", async (t) => {
  const previous = record(alice, "Precedente");
  const active = { ...record(alice, "Attiva"), revision: 2 };
  const { w, state } = await mount(t, { plans: new Map([[alice, active]]) });
  for (const response of [previous, null]) {
    if (response) state.plans.set(alice, response);
    else state.plans.delete(alice);
    await w.workoutLibrary.load();
    assert.equal(w.workoutLibrary.snapshot().record.id, active.id);
    assert.match(w.workoutLibrary.snapshot().error, /Risposta del server precedente/);
    assert.equal(JSON.parse(w.localStorage.getItem(`workout.personalPlan:${alice}`)).id, active.id);
  }
});

test("a failed deletion check retains the cached plan with an explicit error", async (t) => {
  const previous = record(alice, "Precedente");
  const active = { ...record(alice, "Attiva"), revision: 2 };
  const { w, state } = await mount(t, { plans: new Map([[alice, active]]) });
  state.plans.set(alice, previous);
  state.records.delete(active.id);
  state.beforePlan = async (_userId, versionId) => {
    if (versionId) state.planError = new Error("Verification unavailable");
  };
  await w.workoutLibrary.load();
  assert.equal(w.workoutLibrary.snapshot().record.id, active.id);
  assert.match(w.workoutLibrary.snapshot().error, /Verification unavailable/);
  assert.equal(JSON.parse(w.localStorage.getItem(`workout.personalPlan:${alice}`)).id, active.id);
});

test("a deletion check is scoped to the current member even for another member's version ID", async (t) => {
  const other = record(bob, "Privata Bob");
  const { w } = await mount(t, { plans: new Map([[bob, other]]) });
  assert.equal(await w.workoutSocial.fetchPersonalPlan(alice, other.id), null);
  await assert.rejects(w.workoutSocial.fetchPersonalPlan(bob, other.id), /account|Account|accesso|Accesso/);
});

test("deletion verification cannot override a save, a newer load, or an account change", async (t) => {
  for (const action of ["save", "load", "account"]) {
    const previous = record(alice, "Precedente");
    const active = { ...record(alice, "Attiva"), revision: 2 };
    const other = record(bob, "Bob");
    const { w, state } = await mount(t, { plans: new Map([[alice, active], [bob, other]]) });
    state.plans.set(alice, previous);
    state.records.delete(active.id);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let waiting = false;
    state.beforePlan = async (_userId, versionId) => {
      if (versionId === active.id) { waiting = true; await gate; }
    };
    const loading = w.workoutLibrary.load();
    await until(() => waiting);
    let expected;
    if (action === "save") {
      state.plans.set(alice, active);
      const draft = w.workoutLibrary.writeDraft(structuredClone(definition));
      expected = await w.workoutLibrary.save(draft);
    } else if (action === "load") {
      expected = { ...record(alice, "Nuova"), revision: 3 };
      state.plans.set(alice, expected);
      await w.workoutLibrary.load();
    } else {
      expected = other;
      state.id = bob;
      state.callback("SIGNED_IN", { user: { id: bob } });
      await until(() => w.workoutLibrary.snapshot().record?.id === other.id);
    }
    release();
    await loading;
    assert.equal(w.workoutLibrary.snapshot().record.id, expected.id, action);
    assert.equal(w.workoutLibrary.snapshot().error, "", action);
    assert.equal(w.workoutLibrary.snapshot().loading, false, action);
    assert.equal(JSON.parse(w.localStorage.getItem(`workout.personalPlan:${expected.user_id}`)).id, expected.id);
  }
});

test("a newer remote version never replaces an in-progress local workout without an explicit choice", async (t) => {
  const original = record(alice, "In corso");
  const { w, state } = await mount(t, { plans: new Map([[alice, original]]) });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  const latest = { ...record(alice, "Aggiornata altrove"), revision: 2 };
  state.plans.set(alice, latest);
  await w.workoutLibrary.load();
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.workoutLibrary.snapshot().availableRecord.id, latest.id);
  navigate(w, "plan");
  click(w, "Usa piano aggiornato");
  assert.equal(w.workoutLibrary.snapshot().record.id, latest.id);
  assert.equal(Object.keys(w.getProgress("strength").steps).length, 0);
  assert.ok(w.localStorage.getItem(`workout.progress:${alice}:${original.id}`));
});

test("personal completions queue full result snapshots offline and synchronize into private history", async (t) => {
  const original = record(alice, "Scheda storica");
  const { w, state } = await mount(t, { plans: new Map([[alice, original]]) });
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  completeSet(w);
  completeSet(w);
  click(w, "Salta");
  const pending = w.pendingAttendance(alice);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].workout.planVersionId, original.id);
  assert.equal(pending[0].workout.steps["squat:2"], "skipped");
  const completedAt = pending[0].completedAt;
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await w.workoutSocial.refresh();
  assert.equal(w.pendingAttendance(alice).length, 0);
  const submission = state.calls.find((call) => call.name === "submit_workout_result");
  assert.equal(submission.args.p_completed_at, completedAt);
  assert.equal(state.calls.filter((call) => call.name === "submit_gym_day").length, 0);
  navigate(w, "profile");
  await until(() => !w.workoutLibrary.snapshot().historyLoading);
  assert.match(w.document.body.textContent, /Scheda storica \(v1\)/);
  assert.match(w.document.body.textContent, /Squat, serie 3 · Obiettivo: 5 ripetizioni · Effettivo: Non registrato: Saltato/);
});

test("a delayed import from an old account cannot overwrite the next account's draft", async (t) => {
  const { w, state } = await mount(t);
  navigate(w, "plan");
  const file = w.document.querySelector('input[type="file"]');
  let completeFile;
  const text = new Promise((resolve) => { completeFile = resolve; });
  Object.defineProperty(file, "files", { value: [{ name: "plan.csv", size: 500, text: () => text }] });
  file.dispatchEvent(new w.Event("change"));
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  await until(() => w.workoutLibrary.snapshot().userId === bob && !w.workoutLibrary.snapshot().loading);
  completeFile(w.exportWorkoutCsv(definition));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(w.localStorage.getItem(`workout.planDraft:${bob}`), null);
});

test("an auth change during a slow refresh queues a new refresh and discards the old account's response", async (t) => {
  const a = record(alice, "Alice");
  const b = record(bob, "Bob");
  const { w, state } = await mount(t, { plans: new Map([[alice, a], [bob, b]]) });
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let waiting = false;
  state.beforePlan = async (userId) => {
    if (userId === alice) { waiting = true; await slow; }
  };
  const refresh = w.workoutSocial.refresh();
  await until(() => waiting);
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await refresh;
  await until(() => w.workoutLibrary.snapshot().record?.id === b.id);
  assert.equal(w.workoutLibrary.snapshot().userId, bob);
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Bob");
});

test("private plans still load when the public example is unavailable", async (t) => {
  const original = record(alice, "Solo Supabase");
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]), templateError: new Error("404") });
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Solo Supabase");
  assert.match(app.textContent, /Riscaldamento/);
  navigate(w, "profile");
  assert.match(app.textContent, /Classifica/);
});

test("a successful in-flight save never erases edits made to the draft while it was pending", async (t) => {
  const original = record(alice, "Originale");
  const { w } = await mount(t, { plans: new Map([[alice, original]]) });
  const firstDefinition = { ...structuredClone(definition), title: "Prima modifica" };
  const firstDraft = w.workoutLibrary.writeDraft(firstDefinition);
  let finishSave;
  const response = new Promise((resolve) => { finishSave = resolve; });
  w.workoutSocial.savePersonalPlan = async () => response;
  const pendingSave = w.workoutLibrary.save(firstDraft);
  const secondDraft = w.workoutLibrary.writeDraft({ ...structuredClone(definition), title: "Modifica successiva" });
  finishSave({ ...original, id: firstDraft.versionId, revision: 2, definition: structuredClone(firstDefinition) });
  await pendingSave;
  assert.equal(w.workoutLibrary.getDraft().versionId, secondDraft.versionId);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Modifica successiva");
  assert.equal(w.workoutLibrary.snapshot().record.revision, 2);
});

test("a stale fetch cannot downgrade a newly published version", async (t) => {
  const original = record(alice, "Originale");
  const { w } = await mount(t, { plans: new Map([[alice, original]]) });
  let finishFetch;
  const response = new Promise((resolve) => { finishFetch = resolve; });
  w.workoutSocial.fetchPersonalPlan = async () => response;
  const fetch = w.workoutLibrary.load();
  const draft = w.workoutLibrary.writeDraft({ ...structuredClone(definition), title: "Pubblicata" });
  await w.workoutLibrary.save(draft);
  assert.equal(w.workoutLibrary.snapshot().record.revision, 2);
  finishFetch(original);
  await fetch;
  assert.equal(w.workoutLibrary.snapshot().record.revision, 2);
  assert.equal(w.workoutLibrary.snapshot().loading, false);
});

test("three-tab navigation migrates old selections and defaults to Plan", async (t) => {
  for (const [stored, expected] of [
    ["day", "plan"], ["leaderboard", "profile"], ["workout", "workout"],
    ["progress", "profile"], ["profile", "profile"], ["invalid", "plan"], [null, "plan"],
  ]) {
    const { w } = await mount(t, {
      plans: new Map([[alice, record(alice, "Piano")]]),
      storage: stored ? { "workout.activeView": stored } : {},
    });
    assert.deepEqual([...w.document.querySelectorAll(".app-nav button")].map((button) => button.dataset.view),
      ["plan", "workout", "profile"]);
    assert.equal(w.getActiveView(), expected);
    assert.equal(w.document.querySelector('.app-nav [aria-current="page"]').dataset.view, expected);
    if (["day", "leaderboard", "progress"].includes(stored)) assert.equal(w.localStorage.getItem("workout.activeView"), expected);
  }
});

test("Plan browses daily and full views without mutating the active workout", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Il mio piano")]]) });
  w.setStepStatus("strength", "warmup:warm", "completed");
  navigate(w, "plan");
  assert.equal(app.querySelector('[aria-pressed="true"]').textContent, "Oggi");
  assert.equal(app.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "33");
  assert.doesNotMatch(app.textContent, /Aggiorna dal server|Storico|versione/);
  const before = snapshotStorage(w);
  const select = app.querySelector('select[aria-label="Consulta una giornata"]');
  select.value = "circuit";
  select.dispatchEvent(new w.Event("change"));
  assert.match(app.textContent, /Piegamenti/);
  assert.match(app.textContent, /allenamento attivo non cambia/);
  assert.equal(w.getCurrentSessionId(definition), "strength");
  assert.deepEqual(snapshotStorage(w), before);
  click(w, "Piano completo");
  assert.equal(app.querySelectorAll(".plan-day").length, 2);
  assert.equal(app.querySelector(".plan-day").open, false);
  assert.equal(app.querySelectorAll(".view-intro").length, 1);
  app.querySelectorAll(".plan-day button")[1].click();
  assert.equal(app.querySelector('select[aria-label="Consulta una giornata"]').value, "circuit");
  click(w, "Torna a oggi");
  assert.equal(app.querySelector('select[aria-label="Consulta una giornata"]').value, "strength");
  navigate(w, "workout");
  assert.match(app.textContent, /Forza/);
  assert.match(app.textContent, /Squat/);
});

test("editor is explicit, keeps drafts on return, and reveals the invalid exercise step", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Piano")]]) });
  assert.equal(app.querySelector(".plan-editor"), null);
  click(w, "Modifica piano");
  assert.equal(app.querySelector('[data-screen="days"].wizard-panel').hidden, true);
  const file = app.querySelector('input[type="file"]');
  assert.equal(file.closest("details").open, false);
  input(w, "Titolo della scheda", "Bozza conservata");
  const exercise = input(w, "Nome esercizio", "");
  assert.equal(exercise.closest(".wizard-panel").hidden, true);
  click(w, "3. Rivedi piano");
  assert.equal(exercise.closest(".wizard-panel").hidden, false);
  assert.equal(w.document.activeElement, exercise);
  input(w, "Nome esercizio", "Squat modificato");
  click(w, "Aggiungi giornata");
  assert.equal([...app.querySelectorAll(".editor-day")].at(-1).open, true);
  click(w, "Torna al piano");
  assert.equal(app.querySelector(".plan-editor"), null);
  assert.match(app.textContent, /Riprendi modifica/);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Bozza conservata");
  navigate(w, "profile");
  navigate(w, "plan");
  assert.equal(app.querySelector(".plan-editor"), null);
  click(w, "Riprendi modifica");
  assert.equal(app.querySelector("input").value, "Bozza conservata");
});

test("Progress separates local completion and pending results from monthly synchronized metrics", async (t) => {
  const { w, state, app } = await mount(t, { plans: new Map([[alice, record(alice, "Piano")]]) });
  state.rows = [{
    user_id: alice, display_name: "Amico", gym_days: 2, points: 22.5,
    weekly_streak: 2, multiplier: 1.25, position: 1, month_start: "2026-10-01",
  }];
  await w.workoutSocial.refresh();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  completeSet(w);
  completeSet(w);
  click(w, "Salta");
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy && !w.workoutLibrary.snapshot().historyLoading);
  assert.equal(app.querySelector(".personal-progress [role=progressbar]").getAttribute("aria-valuenow"), "100");
  assert.deepEqual([...app.querySelectorAll(".progress-metrics dd")].map((cell) => cell.textContent),
    ["2", "22,5", "2 settimane", "1,25×"]);
  assert.equal(app.querySelector(".progress-metrics .metric-unit").textContent, " settimane");
  assert.equal(app.querySelectorAll(".aura-metric").length, 1);
  assert.equal(app.querySelector(".aura-metric dt").textContent, "Punti Aura");
  assert.equal(app.querySelector(".aura-metric dd").textContent, "22,5");
  assert.match(app.textContent, /ottobre 2026/);
  assert.match(app.querySelector(".workout-history").textContent, /1 allenamenti locali in attesa/);
  assert.match(app.querySelector(".workout-history").textContent, /Non ancora inclusi/);
  assert.equal(app.querySelectorAll(".leaderboard-self").length, 1);
  assert.equal(app.querySelector("details.social-panel").open, false);
  assert.equal(w.pendingAttendance(alice).length, 1);
  state.rows[0].points = 35;
  await w.workoutSocial.refresh();
  assert.equal(app.querySelectorAll(".aura-metric").length, 1);
  assert.equal(app.querySelector(".aura-metric dd").textContent, "35");
  assert.equal(app.querySelector(".leaderboard-self .aura-score").textContent, "35");
  assert.equal(app.querySelector(".personal-progress [role=progressbar]").getAttribute("aria-valuenow"), "100");
});

test("schema validation reveals the exercise step and keeps the active plan unchanged", async (t) => {
  const original = record(alice, "Piano attivo");
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  click(w, "Modifica piano");
  const rest = input(w, "Recupero (secondi)", "1.5");
  assert.equal(rest.closest(".wizard-panel").hidden, true);
  app.querySelector(".plan-editor").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.match(rest.validationMessage, /numero intero da 0 a 3600/);
  assert.equal(rest.closest(".wizard-panel").hidden, false);
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.ok(w.workoutLibrary.getDraft());
});

test("an existing plan exposes editing and blank replacement without losing the active plan or draft", async (t) => {
  const original = record(alice, "Piano attuale");
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  const edit = [...app.querySelectorAll("button")].find((button) => button.textContent === "Modifica piano");
  assert.ok(edit.classList.contains("btn-primary"));
  click(w, "Nuovo piano");
  assert.ok(app.querySelector(".creation-paths"));
  assert.equal(w.workoutLibrary.getDraft(), null);
  click(w, "Crea scheda");
  assert.equal(w.workoutLibrary.getDraft().definition.title, "La mia scheda");
  assert.equal(w.workoutLibrary.getDraft().definition.sessions.length, 1);
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  input(w, "Titolo della scheda", "Nuovo piano in bozza");
  click(w, "Torna al piano");
  assert.match(app.textContent, /Piano attuale/);
  assert.equal([...app.querySelectorAll("button")].find((button) => button.textContent === "Nuovo piano").disabled, true);
  click(w, "Riprendi modifica");
  assert.equal(app.querySelector("input").value, "Nuovo piano in bozza");
  click(w, "Scarta bozza e ricarica");
  await until(() => !w.workoutLibrary.snapshot().loading);
  assert.equal(w.workoutLibrary.getDraft(), null);
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal([...app.querySelectorAll("button")].find((button) => button.textContent === "Nuovo piano").disabled, false);
});

test("Progress works without a plan and handles history errors and retry without inventing totals", async (t) => {
  const { w, state, app } = await mount(t);
  state.historyError = new Error("History unavailable");
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy && !w.workoutLibrary.snapshot().historyLoading);
  assert.match(app.querySelector(".personal-progress").textContent, /Crea un piano/);
  assert.match(app.textContent, /History unavailable/);
  assert.equal(app.querySelector(".progress-metrics"), null);
  assert.equal(app.querySelector(".aura-metric"), null);
  assert.doesNotMatch(app.querySelector(".workout-history").textContent, /Nessun allenamento sincronizzato/);
  state.historyError = null;
  click(w, "Aggiorna storico");
  await until(() => !w.workoutLibrary.snapshot().historyLoading);
  assert.match(app.querySelector(".workout-history").textContent, /Nessun allenamento sincronizzato/);
  assert.doesNotMatch(app.textContent, /History unavailable/);
});

test("Progress paginates private history, preserves original definitions, and cleans up on navigation", async (t) => {
  const { w, state, app } = await mount(t, { plans: new Map([[alice, record(alice, "Piano nuovo")]]) });
  const historical = (index) => ({
    id: String(index), completed_at: `2026-10-${String(24 - index).padStart(2, "0")}T12:00:00Z`,
    revision: 1, plan_title: "Piano originale", warmup: definition.warmup,
    session: definition.sessions[1], steps: { "warmup:warm": "completed", "circuit:amrap": "completed" },
    amrap_rounds: 7,
  });
  state.history = Array.from({ length: 20 }, (_, index) => historical(index));
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy && !w.workoutLibrary.snapshot().historyLoading);
  assert.match(app.querySelector(".workout-history").textContent, /AMRAP: 7 giri: Fatto/);
  assert.match(app.querySelector(".workout-history").textContent, /Piegamenti/);
  assert.equal(app.querySelectorAll(".workout-history > details").length, 20);
  state.history = [historical(20)];
  click(w, "Carica precedenti");
  await until(() => !w.workoutLibrary.snapshot().historyLoading);
  assert.equal(app.querySelectorAll(".workout-history > details").length, 21);
  const call = state.calls.filter((entry) => entry.name === "workout_history").at(-1);
  assert.equal(call.args.p_before_id, "19");
  const detached = app.querySelector(".workout-history");
  navigate(w, "plan");
  const oldText = detached.textContent;
  state.history = [historical(21)];
  await w.workoutLibrary.loadHistory();
  assert.equal(detached.textContent, oldText);
  assert.equal(app.querySelector(".workout-history"), null);
  assert.doesNotMatch(app.textContent, /Piano originale/);
});

async function openProfile(t, options = {}) {
  const fixture = await mount(t, { plans: new Map([[alice, record(alice, "Scheda profilo")]]), ...options });
  navigate(fixture.w, "profile");
  await until(() => !fixture.w.workoutSocial.snapshot().busy);
  return fixture;
}

function profileForm(app, kind, values) {
  const form = app.querySelector(`[data-profile-form="${kind}"]`);
  form.closest("details").open = true;
  for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value;
  return form;
}

function submitForm(w, form) {
  if (form.classList.contains("plan-editor")) {
    [...form.querySelectorAll("button")].find((button) => button.textContent === "3. Rivedi piano").click();
  }
  form.dispatchEvent(new w.Event("submit", { cancelable: true }));
}

test("signed-in tabs omit branding and logout until Profile, while status notices remain actionable", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Compatta")]]) });
  assert.equal(w.document.querySelector(".app-header").hidden, true);
  assert.equal(w.document.querySelector("#account-status").hidden, true);
  for (const view of ["plan", "workout"]) {
    navigate(w, view);
    assert.equal(w.document.querySelector("#sign-out"), null);
  }
  w.dispatchEvent(new w.Event("offline"));
  assert.equal(w.document.querySelector("#account-status").hidden, false);
  assert.match(w.document.querySelector("#account-status").textContent, /offline/);
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(app.querySelector("h2").textContent, "Profilo");
  assert.equal(app.querySelectorAll("#sign-out").length, 1);
  assert.equal(app.querySelectorAll('[data-profile-form="name"]').length, 1);
  assert.equal([...app.querySelectorAll("summary")].some((summary) => summary.textContent === "Profilo nel gruppo"), false);
  assert.match(app.querySelector(".profile-summary").textContent, /alice@example.test/);
  assert.ok(app.querySelector(".workout-history"));
});

test("profile name editing trims, validates and refreshes standings without resetting plans or drafts", async (t) => {
  const { w, state, app } = await openProfile(t);
  const original = w.workoutLibrary.snapshot().record.id;
  w.workoutLibrary.writeDraft({ ...structuredClone(definition), title: "Bozza conservata" });
  w.setStepStatus("strength", "warmup:warm", "completed");
  const before = state.calls.filter((call) => call.name === "friends_leaderboard").length;
  const form = profileForm(app, "name", { "display-name": "  Beast  " });
  submitForm(w, form);
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(form.textContent, /Nome aggiornato/);
  assert.equal(state.names.get(alice), "Beast");
  assert.equal(app.querySelector(".profile-summary h3").textContent, "Beast");
  assert.ok(state.calls.filter((call) => call.name === "friends_leaderboard").length > before);
  assert.equal(w.workoutLibrary.snapshot().record.id, original);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Bozza conservata");
  assert.equal(w.getProgress("strength").steps["warmup:warm"], "completed");
  const invalid = await w.workoutSocial.saveName("   ");
  assert.equal(invalid.ok, false);
  assert.equal(state.names.get(alice), "Beast");
});

test("profile edits stay intact on refresh and password inputs clear on leaving the view", async (t) => {
  const { w, app } = await openProfile(t);
  const form = profileForm(app, "email", { email: "draft@example.test", "current-password": "do not store this" });
  await w.workoutSocial.refresh();
  assert.equal(form.elements.email.value, "draft@example.test");
  assert.equal(form.elements["current-password"].value, "do not store this");
  navigate(w, "plan");
  assert.equal(form.elements["current-password"].value, "");
  assert.doesNotMatch(JSON.stringify(snapshotStorage(w)), /do not store this|draft@example.test/);
});

test("password mismatch and invalid input never reach credential APIs", async (t) => {
  const { w, state, app } = await openProfile(t);
  const form = profileForm(app, "password", {
    "current-password": "old secret", "new-password": "new secret", "confirm-password": "mismatch",
  });
  submitForm(w, form);
  assert.match(form.textContent, /non coincidono/);
  assert.equal(state.authCalls, 0);
  assert.equal(state.updates.length, 0);
  assert.ok([...form.querySelectorAll('input[type="password"]')].every((field) => field.value === ""));
  for (const result of [
    await w.workoutSocial.updatePassword("short", "old secret"),
    await w.workoutSocial.updatePassword("long enough", ""),
    await w.workoutSocial.updateEmail("not an email", "old secret"),
    await w.workoutSocial.updateEmail("alice@example.test", "old secret"),
  ]) assert.equal(result.ok, false);
  assert.equal(state.authCalls, 0);
  assert.equal(state.updates.length, 0);
});

test("wrong current password blocks email/password updates and allows retry", async (t) => {
  const { w, state, app } = await openProfile(t);
  state.credentialError = new Error("Invalid login credentials");
  const form = profileForm(app, "email", { email: "next@example.test", "current-password": "wrong secret" });
  submitForm(w, form);
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(form.textContent, /non riuscita.*Invalid login credentials/);
  assert.equal(state.updates.length, 0);
  assert.equal(form.elements["current-password"].value, "");
  assert.equal(form.elements.email.value, "next@example.test");
  state.credentialError = null;
  form.elements["current-password"].value = "correct secret";
  submitForm(w, form);
  await until(() => /Email aggiornata/.test(form.textContent));
  assert.equal(state.updates.length, 1);
  assert.equal(state.emails.get(alice), "next@example.test");
  assert.match(app.querySelector(".profile-summary").textContent, /next@example.test/);
});

test("password changes reauthenticate the current email, preserve owner state and keep feedback through auth refresh", async (t) => {
  const { w, state, app } = await openProfile(t);
  const original = w.workoutLibrary.snapshot().record.id;
  w.setStepStatus("strength", "warmup:warm", "completed");
  const form = profileForm(app, "password", {
    "current-password": "old secret", "new-password": "new secret", "confirm-password": "new secret",
  });
  submitForm(w, form);
  assert.ok([...form.querySelectorAll('input[type="password"]')].every((field) => field.value === ""));
  await until(() => /Password aggiornata/.test(form.textContent));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(state.login.email, "alice@example.test");
  assert.equal(state.login.password, "old secret");
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].password, "new secret");
  assert.equal(w.workoutLibrary.snapshot().record.id, original);
  assert.equal(w.getProgress("strength").steps["warmup:warm"], "completed");
  assert.equal(form, app.querySelector('[data-profile-form="password"]'));
  assert.match(form.textContent, /Password aggiornata/);
  assert.doesNotMatch(JSON.stringify(snapshotStorage(w)), /old secret|new secret/);
  assert.doesNotMatch(JSON.stringify(w.workoutSocial.snapshot()), /old secret|new secret/);
});

test("pending email changes display the effective address until confirmation", async (t) => {
  const { w, state, app } = await openProfile(t);
  state.requireEmailConfirmation = true;
  const form = profileForm(app, "email", { email: "pending@example.test", "current-password": "old secret" });
  submitForm(w, form);
  await until(() => /Modifica email richiesta/.test(form.textContent));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(app.querySelector(".profile-summary").textContent, /alice@example.test/);
  assert.doesNotMatch(app.querySelector(".profile-summary").textContent, /pending@example.test/);
  assert.match(app.querySelector(".profile-settings:nth-of-type(2)").textContent, /In attesa di conferma: pending@example.test/);
  assert.equal(form.elements["current-password"].value, "");
  state.emails.set(alice, "pending@example.test");
  state.pendingEmail = null;
  await w.workoutSocial.refresh();
  assert.match(app.querySelector(".profile-summary").textContent, /pending@example.test/);
  assert.doesNotMatch(app.textContent, /In attesa di conferma:/);
  assert.equal(w.workoutSocial.snapshot().user.id, alice);
});

test("backend credential policy, duplicate-email, rate-limit and network errors remain explicit", async (t) => {
  const { w, state, app } = await openProfile(t);
  for (const message of ["Password too weak", "Email already registered", "Rate limit exceeded", "Network unavailable", "Reauthentication nonce required"]) {
    state.updateError = new Error(message);
    const result = message === "Password too weak"
      ? await w.workoutSocial.updatePassword("long enough", "old secret")
      : await w.workoutSocial.updateEmail("next@example.test", "old secret");
    assert.equal(result.ok, false);
    assert.ok(result.error.includes(message));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await until(() => !w.workoutSocial.snapshot().busy);
  }
  assert.match(app.querySelector(".profile-summary").textContent, /alice@example.test/);
});

test("an expired session prevents reauthentication and updates without discarding the loaded plan", async (t) => {
  const { w, state } = await openProfile(t);
  const original = w.workoutLibrary.snapshot().record.id;
  state.authError = new Error("Session expired");
  const result = await w.workoutSocial.updatePassword("long enough", "old secret");
  assert.equal(result.ok, false);
  assert.match(result.error, /Session expired/);
  assert.equal(state.authCalls, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(w.workoutLibrary.snapshot().record.id, original);
});

test("duplicate submissions and logout are gated while credentials are being updated", async (t) => {
  const { w, state, app } = await openProfile(t);
  let release;
  state.beforeUpdate = () => new Promise((resolve) => { release = resolve; });
  const form = profileForm(app, "email", { email: "next@example.test", "current-password": "old secret" });
  submitForm(w, form);
  await until(() => Boolean(release));
  submitForm(w, form);
  assert.equal(state.updates.length, 1);
  assert.equal(app.querySelector("#sign-out").disabled, true);
  await w.workoutSocial.signOut();
  assert.equal(w.workoutSocial.snapshot().user.id, alice);
  await w.workoutSocial.refresh();
  release();
  await until(() => /Email aggiornata/.test(form.textContent));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(state.updates.length, 1);
  assert.equal(state.authCalls, 1);
});

test("an identity switch during verification prevents any credential update", async (t) => {
  const { w, state, app } = await openProfile(t);
  let release;
  state.beforeSession = () => new Promise((resolve) => { release = resolve; });
  const form = profileForm(app, "email", { email: "next@example.test", "current-password": "old secret" });
  submitForm(w, form);
  await until(() => Boolean(release));
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob, email: "bob@example.test" } });
  state.beforeSession = null;
  release();
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(state.updates.length, 0);
  assert.equal(form.elements["current-password"].value, "");
  assert.doesNotMatch(app.textContent, /next@example.test|Email aggiornata/);
});

test("an identity switch during update discards old-profile feedback and inputs", async (t) => {
  const { w, state, app } = await openProfile(t);
  let release;
  state.beforeUpdate = () => new Promise((resolve) => { release = resolve; });
  const form = profileForm(app, "email", { email: "alice-new@example.test", "current-password": "old secret" });
  submitForm(w, form);
  await until(() => Boolean(release));
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob, email: "bob@example.test" } });
  release();
  await until(() => !w.workoutSocial.snapshot().busy);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(w.workoutSocial.snapshot().user.id, bob);
  assert.equal(state.emails.get(bob), "bob@example.test");
  assert.equal(form.elements["current-password"].value, "");
  assert.doesNotMatch(app.textContent, /alice-new@example.test|Email aggiornata/);
});

test("leaving Profile during an update clears secrets and does not inject feedback into another tab", async (t) => {
  const { w, state, app } = await openProfile(t);
  let release;
  state.beforeUpdate = () => new Promise((resolve) => { release = resolve; });
  const form = profileForm(app, "email", { email: "next@example.test", "current-password": "old secret" });
  submitForm(w, form);
  await until(() => Boolean(release));
  navigate(w, "plan");
  assert.equal(form.elements["current-password"].value, "");
  release();
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.doesNotMatch(app.textContent, /Email aggiornata/);
  assert.equal(w.getActiveView(), "plan");
});
test("switching accounts clears Progress history and metrics without exposing the previous owner", async (t) => {
  const { w, state, app } = await mount(t, {
    plans: new Map([[alice, record(alice, "Alice")], [bob, record(bob, "Bob")]]),
  });
  state.history = [{
    id: "private", completed_at: "2026-10-24T12:00:00Z", revision: 1, plan_title: "Privato Alice",
    warmup: definition.warmup, session: definition.sessions[0], steps: {}, amrap_rounds: null,
  }];
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy && !w.workoutLibrary.snapshot().historyLoading);
  assert.match(app.textContent, /Privato Alice/);
  state.history = [];
  state.rows = [];
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  assert.doesNotMatch(app.textContent, /Privato Alice/);
  await until(() => w.workoutSocial.snapshot().accessReady && !w.workoutSocial.snapshot().busy
    && !w.workoutLibrary.snapshot().historyLoading);
  assert.equal(w.getActiveView(), "profile");
  assert.doesNotMatch(app.textContent, /Privato Alice/);
  assert.match(app.textContent, /Nessun allenamento sincronizzato/);
});

test("per-set actuals persist through navigation and correction, then snapshot atomically offline", async (t) => {
  const {w,app} = await mount(t,{plans:new Map([[alice,record(alice,"Piano")]])});
  Object.defineProperty(w.navigator,"onLine",{value:false,configurable:true});
  navigate(w,"workout");
  click(w,"Riscaldamento completato");
  input(w,"Peso (kg)","20");
  input(w,"Ripetizioni","8");
  navigate(w,"profile");
  navigate(w,"workout");
  assert.equal(app.querySelector('[data-actual-field="weightKg"]').value,"20");
  click(w,"Serie completata");
  click(w,"Salta recupero");
  click(w,"Indietro");
  assert.equal(app.querySelector('[data-actual-field="reps"]').value,"8");
  input(w,"Peso (kg)","22");
  click(w,"Serie completata");
  click(w,"Salta recupero");
  assert.equal(app.querySelector('[aria-label="Misura effettiva"]'), null);
  input(w,"Peso (kg)","0");
  input(w,"Ripetizioni","6");
  click(w,"Serie completata");
  click(w,"Salta recupero");
  click(w,"Salta");
  const receipt = w.pendingAttendance(alice)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(receipt.workout.measurements)),
    {"squat:0":{weightKg:22,reps:8},"squat:1":{weightKg:0,reps:6}});
  assert.equal(receipt.workout.amrapExtraReps,null);
  navigate(w,"profile");
  navigate(w,"workout");
  assert.equal(w.pendingAttendance(alice).length,1);
  w.clearProgress("strength");
  navigate(w,"plan");
  navigate(w,"workout");
  click(w,"Riscaldamento completato");
  assert.equal(app.querySelector('[data-actual-field="weightKg"]').value,"");
  assert.equal(app.querySelector('[data-actual-field="reps"]').value,"");
});

test("optional set notes persist independently across correction, navigation and reload, then enter private receipts", async (t) => {
  const original = record(alice, "Note");
  const plans = new Map([[alice, original]]);
  const first = await mount(t, { plans });
  navigate(first.w, "workout");
  click(first.w, "Riscaldamento completato");
  const note = input(first.w, "Note della serie (facoltative)", "Presa stretta <img src=x onerror=alert(1)>");
  assert.equal(note.required, false);
  assert.equal(note.maxLength, 1000);
  assert.equal(first.app.querySelector("[data-complete-set]").disabled, true);
  input(first.w, "Peso (kg)", "20");
  input(first.w, "Ripetizioni", "8");
  navigate(first.w, "profile");
  navigate(first.w, "workout");
  assert.equal(first.app.querySelector("[data-set-notes]").value, note.value);
  const { w, app } = await mount(t, { plans, storage: snapshotStorage(first.w) });
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  assert.equal(app.querySelector("[data-set-notes]").value, note.value);
  click(w, "Serie completata");
  click(w, "Salta recupero");
  assert.equal(app.querySelector("[data-set-notes]").value, "");
  click(w, "Indietro");
  input(w, "Note della serie (facoltative)", "Presa stretta, ultima ripetizione lenta");
  click(w, "Serie completata");
  click(w, "Salta recupero");
  input(w, "Note della serie (facoltative)", "   ");
  input(w, "Peso (kg)", "22");
  input(w, "Ripetizioni", "6");
  click(w, "Serie completata");
  click(w, "Salta recupero");
  click(w, "Salta");
  const receipt = w.pendingAttendance(alice)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(receipt.workout.measurements)), {
    "squat:0": { weightKg: 20, reps: 8, notes: "Presa stretta, ultima ripetizione lenta" },
    "squat:1": { weightKg: 22, reps: 6 },
  });
  navigate(w, "profile");
  navigate(w, "workout");
  assert.equal(w.pendingAttendance(alice)[0].workout.measurements["squat:0"].notes, "Presa stretta, ultima ripetizione lenta");
  w.undoLastStep("strength");
  w.undoLastStep("strength");
  navigate(w, "plan");
  navigate(w, "workout");
  assert.equal(app.querySelector("[data-set-notes]").disabled, false);
  assert.equal(app.querySelector("[data-set-notes]").closest("fieldset").disabled, true);
});

test("notes appear safely in previous results, private history and performance details", async (t) => {
  const { w, state, app } = await mount(t, { plans: new Map([[alice, record(alice, "Note private")]]) });
  const notes = "<img src=x onerror=alert(1)> Presa stretta";
  state.previous = { completed_at: "2026-10-01Z", sets: [{ set: 1, weightKg: 20, reps: 8, notes }] };
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  await until(() => app.querySelector(".previous-result").textContent.includes(notes));
  assert.equal(app.querySelector("[data-set-notes]").value, "");
  assert.equal(app.querySelector(".previous-result img"), null);
  state.history = [{
    id: "notes-history", completed_at: "2026-10-01Z", revision: 1, plan_title: "Note private",
    warmup: definition.warmup, session: definition.sessions[0],
    steps: { "warmup:warm": "completed", "squat:0": "completed" },
    measurements: { "squat:0": { weightKg: 20, reps: 8, notes } },
  }];
  const seriesKey = "a".repeat(32);
  state.performance = {
    series: [{ series_key: seriesKey, name: "Squat", context: "Forza", kind: "standard", workouts: 1, best_weight: 20 }],
    results: [{ id: "notes-history", series_key: seriesKey, completed_at: "2026-10-01Z", sets: [{ set: 1, weightKg: 20, reps: 8, notes }], max_weight: 20, max_reps: 8 }],
    more: false,
  };
  navigate(w, "profile");
  await until(() => app.querySelector(".workout-history").textContent.includes(notes)
    && app.querySelector(".performance-table")?.textContent.includes(notes));
  assert.equal(app.querySelector(".workout-history img"), null);
  assert.equal(app.querySelector(".performance-table img"), null);
});

test("notes respect their length limit and storage errors without replacing required seconds", async (t) => {
  const original = record(alice, "Note durata");
  Object.assign(original.definition.sessions[0].exercises[0], { measurementMode: "seconds", usesWeight: false });
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  input(w, "Note della serie (facoltative)", "a".repeat(1000));
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  input(w, "Durata (secondi)", "30");
  assert.equal(app.querySelector("[data-complete-set]").disabled, false);
  input(w, "Note della serie (facoltative)", "a".repeat(1001));
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  assert.match(app.querySelector("[data-measurement-error]").textContent, /massimo 1000/);
  input(w, "Note della serie (facoltative)", "");
  assert.equal(app.querySelector("[data-complete-set]").disabled, false);
  const originalSetItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key.startsWith("workout.progress")) throw new Error("Spazio esaurito");
    return originalSetItem.call(this, key, value);
  };
  input(w, "Note della serie (facoltative)", "Non salvata");
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  assert.match(app.querySelector("[data-measurement-error]").textContent, /Risultato non salvato/);
  w.Storage.prototype.setItem = originalSetItem;
  input(w, "Note della serie (facoltative)", "Recuperata");
  assert.equal(app.querySelector("[data-complete-set]").disabled, false);
  assert.equal(w.getProgress("strength").results["squat:0"].notes, "Recuperata");
});

test("invalid and blank actual inputs disable completion while explicit zero is valid", async (t) => {
  const {w,app} = await mount(t,{plans:new Map([[alice,record(alice,"Piano")]])});
  Object.defineProperty(w.navigator,"onLine",{value:false,configurable:true});
  navigate(w,"workout");
  click(w,"Riscaldamento completato");
  const complete = app.querySelector("[data-complete-set]");
  assert.equal(complete.disabled, true);
  input(w,"Peso (kg)","-1");
  input(w,"Ripetizioni","8");
  assert.equal(complete.disabled, true);
  click(w,"Serie completata");
  assert.equal(w.getProgress("strength").steps["squat:0"],undefined);
  input(w,"Peso (kg)","0");
  input(w,"Ripetizioni","0");
  assert.equal(complete.disabled, false);
  click(w,"Serie completata");
  click(w,"Salta recupero");
  input(w,"Peso (kg)","0");
  input(w,"Ripetizioni","0");
  click(w,"Serie completata");
  click(w,"Salta recupero");
  click(w,"Salta");
  assert.deepEqual(JSON.parse(JSON.stringify(w.pendingAttendance(alice)[0].workout.measurements)),
    {"squat:0":{weightKg:0,reps:0},"squat:1":{weightKg:0,reps:0}});
});

test("previous set values are reference-only and AMRAP extra reps survive navigation and completion", async (t) => {
  const {w,state,app} = await mount(t,{plans:new Map([[alice,record(alice,"Piano")]])});
  state.previous = {completed_at:"2026-10-01Z",sets:[{set:1,weightKg:20,reps:8}],rounds:4,extra_reps:2};
  navigate(w,"workout");
  click(w,"Riscaldamento completato");
  await until(() => /20 kg/.test(app.querySelector(".previous-result").textContent));
  assert.equal(app.querySelector('[data-actual-field="weightKg"]').value,"");
  Object.defineProperty(w.navigator,"onLine",{value:false,configurable:true});
  w.setCurrentSessionId("circuit");
  w.updateAmrap("circuit",{remainingMilliseconds:0,rounds:5});
  navigate(w,"plan");
  navigate(w,"workout");
  click(w,"Riscaldamento completato");
  input(w,"Ripetizioni extra (facoltative)","7");
  navigate(w,"profile");
  navigate(w,"workout");
  assert.equal(app.querySelector('[data-actual-field="extraReps"]').value,"7");
  click(w,"Completa AMRAP");
  const receipt = w.pendingAttendance(alice)[0];
  assert.equal(receipt.workout.amrapRounds,5);
  assert.equal(receipt.workout.amrapExtraReps,7);
});

test("private performance displays actual set comparisons and full-history bests with retry states", async (t) => {
  const {w,state,app} = await mount(t,{plans:new Map([[alice,record(alice,"Piano")]])});
  const key = "a".repeat(32);
  state.performance = {
    series:[{series_key:key,name:"Squat",context:"Forza",kind:"standard",workouts:25,best_weight:100,best_reps:8,best_seconds:null}],
    results:[
      {id:"new",series_key:key,completed_at:"2026-10-20Z",sets:[{set:1,weightKg:22,reps:8}],max_weight:22,max_reps:8,max_seconds:null},
      {id:"old",series_key:key,completed_at:"2026-10-13Z",sets:[{set:1,weightKg:20,reps:8}],max_weight:20,max_reps:8,max_seconds:null},
    ],more:true,
  };
  navigate(w,"profile");
  await until(() => Boolean(app.querySelector(".performance-chart")));
  assert.match(app.querySelector(".personal-performance").textContent,/\+2 kg/);
  assert.match(app.querySelector(".personal-performance").textContent,/100 kg/);
  assert.match(app.querySelector(".personal-performance").textContent,/2 risultati caricati di 25/);
  assert.equal(app.querySelector(".performance-table tbody").children.length,2);
  state.performanceError = new Error("Rete assente");
  click(w,"Aggiorna statistiche");
  await until(() => /Rete assente/.test(app.querySelector(".personal-performance").textContent));
  assert.match(app.querySelector(".personal-performance").textContent,/dati precedenti/);
  assert.match(app.querySelector(".personal-performance").textContent,/\+2 kg/);
  state.performanceError = null;
  click(w,"Riprova statistiche");
  await until(() => !/Rete assente/.test(app.querySelector(".personal-performance").textContent));
});

test("late performance responses cannot expose the previous account's measurements", async (t) => {
  const {w,state,app} = await mount(t,{plans:new Map([[alice,record(alice,"Alice")],[bob,record(bob,"Bob")]])});
  state.performance = {
    series:[{series_key:"a".repeat(32),name:"Privato Alice",context:"Forza",kind:"standard",workouts:1,best_weight:100}],
    results:[],more:false,
  };
  const releases = [];
  state.beforeRpc = (name) => name === "workout_performance" && state.id === alice
    ? new Promise((resolve) => releases.push(resolve)) : undefined;
  navigate(w,"profile");
  await until(() => releases.length > 0);
  state.performance = {series:[],results:[],more:false};
  state.id = bob;
  state.callback("SIGNED_IN",{user:{id:bob}});
  await until(() => w.workoutSocial.snapshot().accessReady && !w.workoutSocial.snapshot().busy);
  for (const release of releases) release();
  await new Promise((resolve) => setTimeout(resolve,10));
  assert.doesNotMatch(app.textContent,/Privato Alice|100 kg/);
  assert.match(app.textContent,/Nessuna misurazione sincronizzata/);
});

test("exercise tracking choices persist in editor drafts and publication fixes the training fields", async (t) => {
  const original = record(alice, "Configurazione");
  const plans = new Map([[alice, original]]);
  const first = await mount(t, { plans });
  click(first.w, "Modifica piano");
  const mode = input(first.w, "Tracciamento", "seconds");
  mode.dispatchEvent(new first.w.Event("change"));
  const weight = [...first.app.querySelectorAll("label")].find((label) => label.firstChild.textContent === "Prevede un peso").querySelector("input");
  weight.checked = false;
  weight.dispatchEvent(new first.w.Event("change"));
  assert.equal(first.w.workoutLibrary.getDraft().definition.sessions[0].exercises[0].measurementMode, "seconds");
  assert.equal(first.w.workoutLibrary.getDraft().definition.sessions[0].exercises[0].usesWeight, false);
  assert.equal(first.w.workoutLibrary.snapshot().plan.sessions[0].exercises[0].measurementMode, "reps");

  const { w, app } = await mount(t, { plans, storage: snapshotStorage(first.w) });
  click(w, "Riprendi modifica");
  const restoredMode = [...app.querySelectorAll("label")].find((label) => label.firstChild.textContent === "Tracciamento").querySelector("select");
  assert.equal(restoredMode.value, "seconds");
  assert.equal(app.querySelector(".tracking-weight input").checked, false);
  submitForm(w, app.querySelector(".plan-editor"));
  await until(() => w.workoutLibrary.snapshot().record.revision === 2);
  assert.match(app.textContent, /Tracciamento: durata in secondi/);
  assert.doesNotMatch(app.textContent, /e peso \(kg\)/);
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  assert.equal(app.querySelector('[aria-label="Misura effettiva"]'), null);
  assert.equal(app.querySelector('[data-actual-field="reps"]'), null);
  assert.equal(app.querySelector('[data-actual-field="weightKg"]'), null);
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  input(w, "Durata (secondi)", "30");
  assert.equal(app.querySelector("[data-complete-set]").disabled, false);
  click(w, "Serie completata");
  click(w, "Salta recupero");
  input(w, "Durata (secondi)", "25");
  click(w, "Serie completata");
  click(w, "Salta recupero");
  click(w, "Salta");
  assert.deepEqual(JSON.parse(JSON.stringify(w.pendingAttendance(alice)[0].workout.measurements)),
    { "squat:0": { seconds: 30 }, "squat:1": { seconds: 25 } });
});

test("completion requires valid persisted configured values and excludes hidden stale metrics", async (t) => {
  const original = record(alice, "Misure");
  Object.assign(original.definition.sessions[0].exercises[0], { measurementMode: "seconds", usesWeight: false, rest: 0 });
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  w.updateSetResult("strength", "squat:0", { mode: "reps", weightKg: "200", reps: "99" });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  const complete = app.querySelector("[data-complete-set]");
  for (const value of ["", "-1", "1.5", "86401"]) {
    input(w, "Durata (secondi)", value);
    assert.equal(complete.disabled, true, `Invalid seconds should disable completion: ${value}`);
  }
  complete.dispatchEvent(new w.Event("click"));
  assert.equal(w.getProgress("strength").steps["squat:0"], undefined);
  assert.match(app.querySelector("[data-measurement-error]").textContent, /Controlla/);
  input(w, "Durata (secondi)", "");

  const setItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key.startsWith("workout.progress")) throw new Error("Spazio esaurito");
    return setItem.call(this, key, value);
  };
  input(w, "Durata (secondi)", "30");
  assert.equal(complete.disabled, true);
  assert.match(app.querySelector("[data-measurement-error]").textContent, /Risultato non salvato.*Spazio esaurito/);
  assert.equal(w.getProgress("strength").results["squat:0"].seconds, "");
  w.Storage.prototype.setItem = setItem;
  input(w, "Durata (secondi)", "30");
  assert.equal(complete.disabled, false);
  click(w, "Serie completata");
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  input(w, "Durata (secondi)", "0");
  click(w, "Serie completata");
  click(w, "Salta");
  assert.deepEqual(JSON.parse(JSON.stringify(w.pendingAttendance(alice)[0].workout.measurements)),
    { "squat:0": { seconds: 30 }, "squat:1": { seconds: 0 } });
});

test("weighted reps require both fields and retain the existing numeric limits", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Limiti")]]) });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  const complete = app.querySelector("[data-complete-set]");
  input(w, "Ripetizioni", "8");
  assert.equal(complete.disabled, true);
  for (const weight of ["", "-1", "2001", "0.001"]) {
    input(w, "Peso (kg)", weight);
    assert.equal(complete.disabled, true, `Invalid weight: ${weight}`);
  }
  input(w, "Peso (kg)", "12.25");
  assert.equal(complete.disabled, false);
  for (const reps of ["", "-1", "0.5", "100001"]) {
    input(w, "Ripetizioni", reps);
    assert.equal(complete.disabled, true, `Invalid reps: ${reps}`);
  }
  input(w, "Ripetizioni", "100000");
  input(w, "Peso (kg)", "2000");
  assert.equal(complete.disabled, false);
});

test("rest replaces the exercise until expiry, preserves pause/resume, and cleans up on navigation", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Recupero")]]) });
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  assert.ok(app.querySelector(".rest-timer"));
  assert.equal(app.querySelector(".rest-timer h3").textContent, "Squat");
  assert.match(app.querySelector(".rest-timer").textContent, /1 di 3 serie completate \(1 opzionali\)/);
  assert.equal(app.querySelector(".focus-card"), null);
  assert.equal(app.querySelector(".workout-actions"), null);
  assert.equal(app.querySelector("[data-complete-set]"), null);
  assert.equal(clock.intervals.size, 1);
  clock.advance(10000);
  assert.equal(app.querySelector(".timer-value").textContent, "00:50");
  click(w, "Pausa");
  assert.match(app.querySelector(".rest-timer").textContent, /Squat.*1 di 3 serie completate/);
  clock.advance(20000);
  assert.equal(w.getProgress("strength").restTimer.remainingMilliseconds, 50000);
  assert.equal(clock.intervals.size, 0);
  navigate(w, "profile");
  navigate(w, "workout");
  assert.equal(app.querySelector(".timer-value").textContent, "00:50");
  assert.match(app.querySelector(".rest-timer").textContent, /Squat.*1 di 3 serie completate/);
  click(w, "Riprendi");
  assert.equal(clock.intervals.size, 1);
  clock.advance(50000);
  assert.equal(clock.intervals.size, 0);
  assert.equal(w.getProgress("strength").restTimer, null);
  assert.equal(app.querySelector(".rest-timer"), null);
  assert.match(app.querySelector(".focus-kicker").textContent, /serie 2 di 3/);
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  navigate(w, "plan");
  assert.equal(clock.intervals.size, 0);
  clock.advance(61000);
  navigate(w, "workout");
  assert.equal(app.querySelector(".rest-timer"), null);
  assert.equal(w.getProgress("strength").restTimer, null);
  assert.match(app.querySelector(".focus-kicker").textContent, /serie 3 di 3/);
});

test("rest identifies the completed exercise at transitions and counts only completed sets", async (t) => {
  const original = record(alice, "Contesto recupero");
  original.definition.sessions[0].exercises.push({
    id: "pushup", name: "Piegamenti", sets: 1, target: "8", rest: 0, measurementMode: "reps", usesWeight: false,
  });
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  w.setStepStatus("strength", "warmup:warm", "completed");
  w.setStepStatus("strength", "squat:0", "skipped");
  navigate(w, "workout");
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  assert.equal(app.querySelector(".rest-timer h3").textContent, "Squat");
  assert.match(app.querySelector(".rest-timer").textContent, /1 di 3 serie completate/);
  click(w, "Salta recupero");
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  assert.equal(app.querySelector(".rest-timer h3").textContent, "Squat");
  assert.match(app.querySelector(".rest-timer").textContent, /2 di 3 serie completate/);
  assert.doesNotMatch(app.querySelector(".rest-timer").textContent, /Piegamenti/);
  click(w, "Salta recupero");
  assert.equal(app.querySelector(".focus-card h3").textContent, "Piegamenti");
});

test("rest persists across reload, expires on visibility return, and quick navigation clears it", async (t) => {
  const original = record(alice, "Ripresa");
  const plans = new Map([[alice, original]]);
  const first = await mount(t, { plans });
  navigate(first.w, "workout");
  click(first.w, "Riscaldamento completato");
  input(first.w, "Peso (kg)", "20");
  input(first.w, "Ripetizioni", "8");
  click(first.w, "Serie completata");
  const { w, app } = await mount(t, { plans, storage: snapshotStorage(first.w) });
  assert.ok(app.querySelector(".rest-timer"));
  assert.match(app.querySelector(".rest-timer").textContent, /Squat.*1 di 3 serie completate/);
  w.updateRestTimer("strength", { durationSeconds: 60, remainingMilliseconds: 60000, deadline: Date.now() - 1 });
  Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  assert.equal(app.querySelector(".rest-timer"), null);
  assert.match(app.querySelector(".focus-kicker").textContent, /serie 2 di 3/);
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  assert.ok(app.querySelector(".rest-timer"));
  const jump = app.querySelector('[aria-label="Vai a un esercizio"]');
  jump.value = "squat:0";
  jump.dispatchEvent(new w.Event("change"));
  assert.equal(w.getProgress("strength").restTimer, null);
  assert.equal(app.querySelector(".rest-timer"), null);
});

test("explicit zero rest advances immediately and the final outstanding set never starts recovery", async (t) => {
  for (const rest of [0, 60]) {
    const original = record(alice, `Recupero ${rest}`);
    Object.assign(original.definition.sessions[0].exercises[0], { rest, sets: 2, optionalSets: 0, usesWeight: false });
    const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
    const clock = controlWorkoutClock(w);
    navigate(w, "workout");
    click(w, "Riscaldamento completato");
    input(w, "Ripetizioni", "8");
    click(w, "Serie completata");
    if (rest === 60) {
      assert.ok(app.querySelector(".rest-timer"));
      click(w, "Salta recupero");
    }
    assert.equal(app.querySelector(".rest-timer"), null);
    assert.match(app.querySelector(".focus-kicker").textContent, /serie 2 di 2/);
    input(w, "Ripetizioni", "8");
    click(w, "Serie completata");
    assert.equal(app.querySelector(".rest-timer"), null);
    assert.equal(clock.intervals.size, 0);
    assert.ok(app.querySelector(".completion-card"));
  }
});

test("an already-expired rest timer is cleared during reload without showing a finished timer", async (t) => {
  const original = record(alice, "Recupero scaduto");
  const plans = new Map([[alice, original]]);
  const first = await mount(t, { plans });
  navigate(first.w, "workout");
  click(first.w, "Riscaldamento completato");
  input(first.w, "Peso (kg)", "20");
  input(first.w, "Ripetizioni", "8");
  click(first.w, "Serie completata");
  first.w.updateRestTimer("strength", { durationSeconds: 60, remainingMilliseconds: 60000, deadline: Date.now() - 1 });
  let audio;
  const { w, app } = await mount(t, {
    plans, storage: snapshotStorage(first.w), beforeBoot: (w) => { audio = fakeAudio(w); },
  });
  assert.equal(audio.beeps, 0);
  assert.equal(audio.contexts, 0);
  assert.equal(app.querySelector(".rest-timer"), null);
  assert.equal(w.getProgress("strength").restTimer, null);
  assert.match(app.querySelector(".focus-kicker").textContent, /serie 2 di 3/);
});

test("sign-out stops rest callbacks without losing the owner's persisted recovery", async (t) => {
  const original = record(alice, "Recupero privato");
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  input(w, "Peso (kg)", "20");
  input(w, "Ripetizioni", "8");
  click(w, "Serie completata");
  const saved = w.localStorage.getItem(`workout.progress:${alice}:${original.id}`);
  assert.equal(clock.intervals.size, 1);
  await w.workoutSocial.signOut();
  assert.equal(clock.intervals.size, 0);
  assert.equal(app.querySelector(".rest-timer"), null);
  clock.advance(61000);
  assert.equal(w.localStorage.getItem(`workout.progress:${alice}:${original.id}`), saved);
});

test("rest skip reveals the next exercise and completing an optional final set finishes directly", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Serie opzionale")]]) });
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  completeSet(w);
  assert.equal(w.getProgress("strength").restTimer, null);
  assert.match(app.querySelector(".focus-kicker").textContent, /serie 2 di 3/);
  completeSet(w);
  assert.match(app.querySelector(".focus-kicker").textContent, /opzionale/);
  completeSet(w);
  assert.ok(app.querySelector(".completion-card"));
  assert.equal(clock.intervals.size, 0);
  assert.equal(w.getProgress("strength").restTimer, null);
});

function timedRecord(target = "15-25 secondi") {
  const original = record(alice, "Esercizi a tempo");
  Object.assign(original.definition.sessions[0].exercises[0], {
    measurementMode: "seconds", usesWeight: false, target,
  });
  return original;
}

test("exercise timer parses only unambiguous bounded time targets and restores legacy state", async (t) => {
  const { w } = await mount(t);
  for (const [target, expected] of [
    ["15 secondi", 15], ["15-25 secondi", 25], ["20\u201325 secondi", 25],
    ["30 secondi di lavoro", 30], ["2 minuti", 120], ["1-2 min", 120],
    ["10 seconds", 10], ["5 sec", 5], ["86400 s", 86400],
    ["Durata libera", null], ["1 blocco", null], ["8 ripetizioni", null],
    ["10 ripetizioni, poi 30 secondi", null], ["5 secondi per lato", null],
    ["0 secondi", null], ["25-15 secondi", null], ["1.5 min", null],
    ["86401 secondi", null], ["1441 minuti", null],
  ]) assert.equal(w.parseExerciseTargetSeconds(target), expected, target);
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  w.updateExerciseTimer("strength", { stepKey: "squat:0", durationSeconds: 25, remainingMilliseconds: 25000, deadline: null });
  assert.equal(w.getProgress("strength").exerciseTimer.stepKey, "squat:0");
  w.updateSetResult("strength", "squat:0", { seconds: "12" });
  assert.equal(w.getProgress("strength").exerciseTimer.durationSeconds, 25);
  assert.equal(w.normalizeExerciseTimer({ ...w.getProgress("strength").exerciseTimer, runId: "wrong" }, w.getProgress("strength").runId), null);
  assert.throws(() => w.updateExerciseTimer("strength", { stepKey: "squat:0", durationSeconds: 0, remainingMilliseconds: 0, deadline: null }));
});

test("exercise timer starts manually, beeps exactly once and never enters results or advances", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, timedRecord()]]) });
  const audio = fakeAudio(w);
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  assert.equal(app.querySelector(".exercise-timer"), null);
  click(w, "Riscaldamento completato");
  assert.equal(app.querySelector(".exercise-timer input").value, "25");
  assert.equal(clock.intervals.size, 0);
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  click(w, "Avvia timer");
  await Promise.resolve();
  assert.equal(audio.contexts, 1);
  assert.equal(app.querySelector(".exercise-timer input").disabled, true);
  clock.advance(24000);
  assert.equal(app.querySelector(".timer-value").textContent, "00:01");
  clock.advance(1000);
  assert.equal(audio.beeps, 1);
  assert.equal(clock.intervals.size, 0);
  assert.match(app.querySelector(".exercise-timer").textContent, /Tempo terminato/);
  assert.equal(app.querySelector("[data-actual-field]").value, "");
  assert.equal(app.querySelector("[data-complete-set]").disabled, true);
  assert.equal(w.getProgress("strength").steps["squat:0"], undefined);
  assert.equal(w.getProgress("strength").restTimer, null);
  Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  clock.advance(25000);
  assert.equal(audio.beeps, 1);
  input(w, "Durata (secondi)", "23");
  click(w, "Serie completata");
  assert.equal(w.getProgress("strength").results["squat:0"].seconds, "23");
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.ok(app.querySelector(".rest-timer"));
});

test("exercise timer validates editable seconds, pauses, resumes and resets without a tone", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, timedRecord("Durata libera")]]) });
  const audio = fakeAudio(w);
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  assert.equal(app.querySelector(".exercise-timer input").value, "");
  for (const value of ["", "0", "-1", "1.5", "86401"]) {
    input(w, "Timer: durata (secondi)", value);
    const start = [...app.querySelectorAll("button")].find((button) => button.textContent === "Avvia timer");
    assert.equal(start.disabled, true, value);
    assert.match(app.querySelector(".exercise-timer [role=alert]").textContent, /1 a 86400/);
    assert.equal(clock.intervals.size, 0);
  }
  input(w, "Timer: durata (secondi)", "86400");
  assert.equal(app.querySelector(".exercise-timer button").disabled, false);
  input(w, "Timer: durata (secondi)", "30");
  click(w, "Avvia timer");
  await Promise.resolve();
  clock.advance(10250);
  click(w, "Pausa");
  assert.equal(w.getProgress("strength").exerciseTimer.remainingMilliseconds, 19750);
  assert.equal(clock.intervals.size, 0);
  clock.advance(60000);
  assert.equal(app.querySelector(".timer-value").textContent, "00:20");
  navigate(w, "profile");
  navigate(w, "workout");
  assert.equal(app.querySelector(".timer-value").textContent, "00:20");
  assert.equal(clock.intervals.size, 0);
  click(w, "Riprendi");
  clock.advance(1000);
  assert.equal(app.querySelector(".timer-value").textContent, "00:19");
  click(w, "Azzera timer");
  assert.equal(clock.intervals.size, 0);
  assert.equal(app.querySelector(".timer-value").textContent, "00:30");
  assert.equal(app.querySelector(".exercise-timer input").disabled, false);
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.equal(audio.beeps, 0);
});

test("exercise timer catches up on visibility return and respects mute and audio failures", async (t) => {
  for (const mode of ["normal", "muted", "unsupported", "resume", "playback"]) {
    const { w, app } = await mount(t, { plans: new Map([[alice, timedRecord("15 secondi")]]) });
    const audio = mode === "unsupported" ? null : fakeAudio(w, { rejectResume: mode === "resume", rejectPlayback: mode === "playback" });
    const clock = controlWorkoutClock(w);
    if (mode === "muted") w.workoutAudio.setMuted(true);
    navigate(w, "workout");
    click(w, "Riscaldamento completato");
    click(w, "Avvia timer");
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(15000, false);
    Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
    w.document.dispatchEvent(new w.Event("visibilitychange"));
    assert.equal(w.getProgress("strength").exerciseTimer.remainingMilliseconds, 0);
    assert.equal(clock.intervals.size, 0);
    if (audio) assert.equal(audio.beeps, mode === "normal" ? 1 : 0, mode);
    if (["unsupported", "resume", "playback"].includes(mode)) {
      assert.match(app.querySelector("[data-audio-status]").textContent, /Suono dei timer non disponibile/);
    }
    input(w, "Durata (secondi)", "15");
    assert.equal(app.querySelector("[data-complete-set]").disabled, false);
  }
});

test("exercise timer restores running and paused deadlines and never plays a stale reload alert", async (t) => {
  const plans = new Map([[alice, timedRecord()]]);
  const first = await mount(t, { plans });
  const firstClock = controlWorkoutClock(first.w);
  navigate(first.w, "workout");
  click(first.w, "Riscaldamento completato");
  click(first.w, "Avvia timer");
  firstClock.advance(5000);
  const second = await mount(t, {
    plans, storage: snapshotStorage(first.w),
    beforeBoot: (w) => { w.Date.now = () => first.w.Date.now(); },
  });
  assert.ok(second.w.getProgress("strength").exerciseTimer.deadline);
  assert.equal(second.app.querySelector(".exercise-timer input").value, "25");
  assert.equal(second.app.querySelector(".timer-value").textContent, "00:20");
  click(second.w, "Pausa");
  const paused = second.w.getProgress("strength").exerciseTimer.remainingMilliseconds;
  assert.equal(paused, 20000);
  const third = await mount(t, { plans, storage: snapshotStorage(second.w) });
  assert.equal(third.w.getProgress("strength").exerciseTimer.deadline, null);
  assert.equal(third.w.getProgress("strength").exerciseTimer.remainingMilliseconds, paused);
  assert.match(third.app.querySelector(".exercise-timer").textContent, /Riprendi/);
  third.w.updateExerciseTimer("strength", { ...third.w.getProgress("strength").exerciseTimer, deadline: third.w.Date.now() - 1 });
  let audio;
  const expired = await mount(t, {
    plans, storage: snapshotStorage(third.w), beforeBoot: (w) => { audio = fakeAudio(w); },
  });
  assert.equal(audio.beeps, 0);
  assert.equal(audio.contexts, 0);
  assert.match(expired.app.querySelector(".exercise-timer").textContent, /Tempo terminato/);
});

test("exercise timer navigation preserves tab state but clears on set, day and account transitions", async (t) => {
  const original = timedRecord();
  const { w, app, state } = await mount(t, { plans: new Map([[alice, original], [bob, record(bob, "Altro account")]]) });
  const audio = fakeAudio(w);
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  click(w, "Avvia timer");
  await Promise.resolve();
  navigate(w, "profile");
  assert.equal(clock.intervals.size, 0);
  clock.advance(30000);
  navigate(w, "workout");
  assert.match(app.querySelector(".exercise-timer").textContent, /Tempo terminato/);
  assert.equal(audio.beeps, 0);
  click(w, "Azzera timer");
  click(w, "Avvia timer");
  input(w, "Durata (secondi)", "8");
  click(w, "Serie completata");
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.ok(app.querySelector(".rest-timer"));
  click(w, "Salta recupero");
  click(w, "Avvia timer");
  click(w, "Indietro");
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.equal(clock.intervals.size, 0);
  click(w, "Avvia timer");
  const jump = app.querySelector('[aria-label="Vai a un esercizio"]');
  jump.value = "squat:0";
  jump.dispatchEvent(new w.Event("change"));
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  click(w, "Avvia timer");
  const day = app.querySelector('[aria-label="Vai a un giorno"]');
  day.value = "circuit";
  day.dispatchEvent(new w.Event("change"));
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.equal(app.querySelector(".exercise-timer"), null);
  assert.equal(clock.intervals.size, 0);
  const returnDay = app.querySelector('[aria-label="Vai a un giorno"]');
  returnDay.value = "strength";
  returnDay.dispatchEvent(new w.Event("change"));
  click(w, "Avvia timer");
  const saved = w.localStorage.getItem(`workout.progress:${alice}:${original.id}`);
  await w.workoutSocial.signOut();
  assert.equal(clock.intervals.size, 0);
  clock.advance(30000);
  assert.equal(w.localStorage.getItem(`workout.progress:${alice}:${original.id}`), saved);
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  await until(() => w.workoutLibrary.snapshot().userId === bob);
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.equal(audio.beeps, 0);
});

test("exercise timer clears for optional skips and progress resets", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, timedRecord()]]) });
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  completeSet(w);
  completeSet(w);
  assert.match(app.querySelector(".focus-kicker").textContent, /opzionale/);
  click(w, "Avvia timer");
  click(w, "Salta");
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.equal(clock.intervals.size, 0);
  assert.ok(app.querySelector(".completion-card"));
  w.clearProgress("strength");
  assert.equal(w.getProgress("strength").exerciseTimer, null);
});

test("exercise timer stays scoped to its plan version when an updated plan is activated", async (t) => {
  const original = timedRecord();
  const { w, app, state } = await mount(t, { plans: new Map([[alice, original]]) });
  const clock = controlWorkoutClock(w);
  const audio = fakeAudio(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  click(w, "Avvia timer");
  await Promise.resolve();
  const latest = { ...timedRecord("10 secondi"), revision: 2 };
  state.plans.set(alice, latest);
  await w.workoutLibrary.load();
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(clock.intervals.size, 1);
  navigate(w, "plan");
  click(w, "Usa piano aggiornato");
  assert.equal(clock.intervals.size, 0);
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  clock.advance(30000);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  assert.equal(app.querySelector(".exercise-timer input").value, "10");
  assert.equal(audio.beeps, 0);
});

test("exercise timer discards mismatched set and run state", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, timedRecord()]]) });
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  w.updateExerciseTimer("strength", { stepKey: "squat:1", durationSeconds: 25, remainingMilliseconds: 25000, deadline: null });
  navigate(w, "plan");
  navigate(w, "workout");
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  click(w, "Avvia timer");
  const store = w.readProgressStore();
  store.sessions.strength.runId = "new-run";
  w.writeProgressStore(store);
  navigate(w, "plan");
  navigate(w, "workout");
  assert.equal(w.getProgress("strength").exerciseTimer, null);
  assert.equal(app.querySelector(".exercise-timer input").disabled, false);
});

test("exercise timer reports storage failures without pretending it started", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, timedRecord()]]) });
  const clock = controlWorkoutClock(w);
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  const setItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key.startsWith("workout.progress")) throw new Error("Spazio esaurito");
    return setItem.call(this, key, value);
  };
  click(w, "Avvia timer");
  assert.match(app.querySelector(".exercise-timer [role=alert]").textContent, /non salvato.*Spazio esaurito/);
  assert.equal(clock.intervals.size, 0);
  assert.equal(w.getProgress("strength").exerciseTimer, null);
});
