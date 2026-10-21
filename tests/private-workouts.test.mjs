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
      { id: "squat", name: "Squat", sets: 2, optionalSets: 1, target: "5 ripetizioni", rest: "60 secondi" },
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
    approved, membershipError, beforeSession, beforeMembership, beforePlan, beforeRpc: null, authError: null };
  for (const entry of plans.values()) state.records.set(entry.id, entry);
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  for (const file of scripts.filter((file) => file !== "app.js")) w.eval(source.get(file));
  const client = {
    auth: {
      getSession: async () => {
        if (state.beforeSession) await state.beforeSession();
        return { data: { session: state.id ? { user: { id: state.id } } : null }, error: state.authError };
      },
      onAuthStateChange: (callback) => { state.callback = callback; },
      signInWithOtp: async (args) => {
        state.login = args;
        return { data: {}, error: state.authError };
      },
      signOut: async () => {
        if (!state.authError) state.id = null;
        return { data: null, error: state.authError };
      },
    },
    from: (table) => {
      let userId = state.id;
      const chain = {
        select: () => chain, order: () => chain, limit: () => chain,
        eq: (_field, value) => { userId = value; return chain; },
        maybeSingle: async () => {
          if (table === "friend_members") {
            if (state.beforeMembership) await state.beforeMembership(userId);
            return { data: state.approved ? { user_id: userId, display_name: "Amico" } : null, error: state.membershipError };
          }
          if (state.beforePlan) await state.beforePlan(userId);
          return { data: plans.get(userId) || null, error: state.planError };
        },
      };
      return chain;
    },
    rpc: async (name, args) => {
      state.calls.push({ name, args });
      if (state.beforeRpc) await state.beforeRpc(name, args);
      if (name === "friends_leaderboard") return { data: [], error: null };
      if (name === "workout_history") return { data: state.history, error: null };
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

test("configured signed-out visits show only Accedi and submit an invited-email magic link", async (t) => {
  const { w, state, app } = await mount(t, { signedIn: false });
  assert.equal(w.document.querySelector(".app-nav").hidden, true);
  assert.equal(w.document.querySelector("#sign-out").hidden, true);
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  assert.doesNotMatch(app.textContent, /Esempio pubblico|Riscaldamento|Classifica/);
  input(w, "Email invitata", "friend@example.com");
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.equal(app.querySelector("button[type=submit]").disabled, true);
  assert.match(app.textContent, /Invio del link/);
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.match(app.textContent, /Controlla la tua email/);
  assert.equal(app.querySelector('input[type="email"]').value, "friend@example.com");
  assert.equal(state.login.email, "friend@example.com");
  assert.equal(state.login.options.shouldCreateUser, false);
  assert.equal(state.login.options.emailRedirectTo, "https://example.github.io/workout/");
  assert.equal(state.calls.length, 0);
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
  assert.equal(w.getActiveView(), "leaderboard");
  assert.equal(w.workoutLibrary.snapshot().record.id, a.id);
  assert.equal(w.document.querySelector('input[type="email"]'), null);
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

test("expired magic links stay on Accedi and allow requesting a fresh link", async (t) => {
  const { w, state, app } = await mount(t, {
    signedIn: false, hash: "#error=access_denied&error_description=Link+expired",
  });
  assert.equal(w.location.hash, "");
  assert.equal(app.querySelector("h2").textContent, "Accedi");
  assert.match(app.textContent, /Link expired/);
  input(w, "Email invitata", "friend@example.com");
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !w.workoutSocial.snapshot().busy);
  assert.equal(state.login.email, "friend@example.com");
  assert.match(app.textContent, /Controlla la tua email/);
});

test("sign-out from a workout immediately hides private data, stops timers and preserves scoped progress", async (t) => {
  const a = record(alice, "Scheda da nascondere");
  const { w, state, app } = await mount(t, { plans: new Map([[alice, a]]) });
  w.setCurrentSessionId("circuit");
  w.setStepStatus("circuit", "warmup:warm", "completed");
  navigate(w, "workout");
  click(w, "Avvia timer");
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
  assert.ok(w.getProgress("circuit").amrap.remainingMilliseconds > 0);
  assert.match(app.textContent, /Circuito/);
});

test("failed sign-out shows a retryable access error without exposing the previous account's plan", async (t) => {
  const a = record(alice, "Scheda privata");
  const { w, state, app } = await mount(t, { plans: new Map([[alice, a]]) });
  navigate(w, "plan");
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
  input(w, "Nome", "Mobilità");
  input(w, "Obiettivo", "5 minuti");
  input(w, "Nome giornata", "Giorno A");
  input(w, "Nome esercizio", "Squat");
  input(w, "Obiettivo / ripetizioni", "5 ripetizioni");
  input(w, "Serie obbligatorie", "2");
  w.document.querySelector(".plan-editor").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => w.workoutLibrary.snapshot().record?.revision === 1);
  assert.equal(state.plans.get(alice).definition.title, "La mia nuova scheda");
  assert.equal(w.workoutLibrary.getDraft(), null);
  navigate(w, "workout");
  assert.match(app.textContent, /Giorno A/);
});

test("offline editor drafts survive reload; publication creates a new version and leaves old progress intact", async (t) => {
  const original = record(alice, "Prima versione");
  const plans = new Map([[alice, original]]);
  const { w } = await mount(t, { plans });
  click(w, "Riscaldamento completato");
  navigate(w, "plan");
  click(w, "Modifica / crea");
  input(w, "Titolo della scheda", "Seconda versione");
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  w.document.querySelector(".plan-editor").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => w.document.querySelector(".social-status")?.textContent?.includes("offline")
    || w.document.body.textContent.includes("Torna online"));
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Seconda versione");
  const second = await mount(t, { plans, storage: snapshotStorage(w) });
  navigate(second.w, "plan");
  assert.ok(second.w.document.querySelector(".plan-editor"));
  assert.equal(second.w.workoutLibrary.getDraft().definition.title, "Seconda versione");
  second.w.document.querySelector(".plan-editor").dispatchEvent(new second.w.Event("submit", { cancelable: true }));
  await until(() => second.w.workoutLibrary.snapshot().record?.revision === 2);
  assert.equal(Object.keys(second.w.getProgress("strength").steps).length, 0);
  const preserved = JSON.parse(second.w.localStorage.getItem(`workout.progress:${alice}:${original.id}`));
  assert.equal(preserved.sessions.strength.steps["warmup:warm"], "completed");
});

test("validated JSON import, structural editing and export are available through the UI", async (t) => {
  const { w } = await mount(t);
  navigate(w, "plan");
  const file = w.document.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", { value: [{ size: 500, text: async () => JSON.stringify(definition) }] });
  file.dispatchEvent(new w.Event("change"));
  await until(() => Boolean(w.document.querySelector(".plan-editor")));
  assert.equal(w.workoutLibrary.getDraft().definition.title, definition.title);
  click(w, "Aggiungi riscaldamento");
  click(w, "Aggiungi giornata");
  assert.equal(w.workoutLibrary.getDraft().definition.warmup.length, 2);
  assert.equal(w.workoutLibrary.getDraft().definition.sessions.length, 3);
  const [first, second] = w.workoutLibrary.getDraft().definition.warmup;
  click(w, "Sposta giù");
  assert.equal(w.workoutLibrary.getDraft().definition.warmup[0].id, second.id);
  assert.equal(w.workoutLibrary.getDraft().definition.warmup[1].id, first.id);
  let downloaded = null;
  w.URL.createObjectURL = () => "blob:demo";
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
  click(w, "Esporta JSON");
  assert.equal(downloaded, "scheda-allenamento.json");
});

test("an invalid JSON import shows errors without overwriting an existing personal plan", async (t) => {
  const original = record(alice, "Originale");
  const { w } = await mount(t, { plans: new Map([[alice, original]]) });
  navigate(w, "plan");
  click(w, "Modifica / crea");
  const file = w.document.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", { value: [{ size: 20, text: async () => '{"version":2}' }] });
  file.dispatchEvent(new w.Event("change"));
  await until(() => w.document.body.textContent.includes("Riscaldamento:"));
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.workoutLibrary.getDraft().definition.title, "Originale");
});

test("a cached personal plan remains usable during a backend outage, with an explicit status", async (t) => {
  const cached = record(alice, "In cache");
  const { w, app } = await mount(t, {
    planError: new Error("Network unavailable"),
    storage: { [`workout.personalPlan:${alice}`]: JSON.stringify(cached) },
  });
  assert.equal(w.workoutLibrary.snapshot().record.id, cached.id);
  assert.match(w.document.querySelector("#account-status").textContent, /Network unavailable/);
  click(w, "Riscaldamento completato");
  assert.match(app.textContent, /Squat/);
});

test("a newer remote version never replaces an in-progress local workout without an explicit choice", async (t) => {
  const original = record(alice, "In corso");
  const { w, state } = await mount(t, { plans: new Map([[alice, original]]) });
  click(w, "Riscaldamento completato");
  const latest = { ...record(alice, "Aggiornata altrove"), revision: 2 };
  state.plans.set(alice, latest);
  await w.workoutLibrary.load();
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.equal(w.workoutLibrary.snapshot().availableRecord.id, latest.id);
  navigate(w, "plan");
  click(w, "Usa versione aggiornata (progressi separati)");
  assert.equal(w.workoutLibrary.snapshot().record.id, latest.id);
  assert.equal(Object.keys(w.getProgress("strength").steps).length, 0);
  assert.ok(w.localStorage.getItem(`workout.progress:${alice}:${original.id}`));
});

test("personal completions queue full result snapshots offline and synchronize into private history", async (t) => {
  const original = record(alice, "Scheda storica");
  const { w, state } = await mount(t, { plans: new Map([[alice, original]]) });
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  click(w, "Riscaldamento completato");
  click(w, "Serie completata");
  click(w, "Serie completata");
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
  navigate(w, "plan");
  click(w, "Storico");
  await until(() => !w.workoutLibrary.snapshot().historyLoading);
  assert.match(w.document.body.textContent, /Scheda storica \(v1\)/);
  assert.match(w.document.body.textContent, /Squat, serie 3 · 5 ripetizioni: Saltato/);
});

test("a delayed import from an old account cannot overwrite the next account's draft", async (t) => {
  const { w, state } = await mount(t);
  navigate(w, "plan");
  const file = w.document.querySelector('input[type="file"]');
  let completeFile;
  const text = new Promise((resolve) => { completeFile = resolve; });
  Object.defineProperty(file, "files", { value: [{ size: 500, text: () => text }] });
  file.dispatchEvent(new w.Event("change"));
  state.id = bob;
  state.callback("SIGNED_IN", { user: { id: bob } });
  await until(() => w.workoutLibrary.snapshot().userId === bob && !w.workoutLibrary.snapshot().loading);
  completeFile(JSON.stringify(definition));
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
  navigate(w, "leaderboard");
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
