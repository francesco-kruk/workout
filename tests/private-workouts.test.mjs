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
      let updates;
      const chain = {
        select: () => chain, order: () => chain, limit: () => chain,
        update: (value) => { updates = value; return chain; },
        single: async () => {
          state.names.set(userId, updates.display_name);
          return { data: { user_id: userId, display_name: updates.display_name }, error: null };
        },
        eq: (_field, value) => { userId = value; return chain; },
        maybeSingle: async () => {
          if (table === "friend_members") {
            if (state.beforeMembership) await state.beforeMembership(userId);
            return { data: state.approved ? { user_id: userId, display_name: state.names.get(userId) || "Amico" } : null, error: state.membershipError };
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
      if (name === "ranking_objectives") return {
        data: { cutover: "2026-10-26", week_start: "2026-10-19", settles_on: "2026-10-26", proposals: [] },
        error: null,
      };
      if (name === "friends_leaderboard") return { data: state.rows, error: null };
      if (name === "workout_history") return { data: state.history, error: state.historyError };
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
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  navigate(w, "plan");
  click(w, "Modifica piano");
  input(w, "Titolo della scheda", "Seconda versione");
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  w.document.querySelector(".plan-editor").dispatchEvent(new w.Event("submit", { cancelable: true }));
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
  click(w, "Modifica piano");
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
  navigate(w, "workout");
  click(w, "Riscaldamento completato");
  assert.match(app.textContent, /Squat/);
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
  navigate(w, "profile");
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

test("editor is explicit, keeps drafts on return, and reveals invalid collapsed fields", async (t) => {
  const { w, app } = await mount(t, { plans: new Map([[alice, record(alice, "Piano")]]) });
  assert.equal(app.querySelector(".plan-editor"), null);
  click(w, "Modifica piano");
  assert.equal(app.querySelector(".editor-day").open, false);
  const file = app.querySelector('input[type="file"]');
  assert.equal(file.closest("details").open, false);
  input(w, "Titolo della scheda", "Bozza conservata");
  const exercise = input(w, "Nome esercizio", "");
  assert.equal(exercise.closest("details").open, false);
  assert.equal(app.querySelector("form").checkValidity(), false);
  let ancestor = exercise.parentElement;
  while (ancestor.tagName !== "FORM") {
    if (ancestor.tagName === "DETAILS") assert.equal(ancestor.open, true);
    ancestor = ancestor.parentElement;
  }
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
    current_streak: 2, multiplier: 1.25, position: 1, month_start: "2026-10-01",
  }];
  await w.workoutSocial.refresh();
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  navigate(w, "workout");
  for (const label of ["Riscaldamento completato", "Serie completata", "Serie completata", "Salta"]) click(w, label);
  navigate(w, "profile");
  await until(() => !w.workoutSocial.snapshot().busy && !w.workoutLibrary.snapshot().historyLoading);
  assert.equal(app.querySelector(".personal-progress [role=progressbar]").getAttribute("aria-valuenow"), "100");
  assert.deepEqual([...app.querySelectorAll(".progress-metrics dd")].map((cell) => cell.textContent),
    ["2", "22,5", "2 allenamenti", "1,25×"]);
  assert.equal(app.querySelector(".progress-metrics .metric-unit").textContent, " allenamenti");
  assert.match(app.textContent, /ottobre 2026/);
  assert.match(app.querySelector(".workout-history").textContent, /1 allenamenti locali in attesa/);
  assert.match(app.querySelector(".workout-history").textContent, /Non ancora inclusi/);
  assert.equal(app.querySelectorAll(".leaderboard-self").length, 1);
  assert.equal(app.querySelector("details.social-panel").open, false);
  assert.equal(w.pendingAttendance(alice).length, 1);
});

test("schema validation reveals collapsed editor sections and keeps the active plan unchanged", async (t) => {
  const original = record(alice, "Piano attivo");
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  click(w, "Modifica piano");
  input(w, "Recupero in secondi (es. 60-90 secondi)", "non valido");
  assert.equal(app.querySelector(".editor-day").open, false);
  app.querySelector(".plan-editor").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.match(app.querySelector(".social-status").textContent, /recupero da 0 a 3600/);
  assert.equal(app.querySelectorAll(".editor-section:not([open])").length, 0);
  assert.equal(w.document.activeElement, app.querySelector(".social-status"));
  assert.equal(w.workoutLibrary.snapshot().record.id, original.id);
  assert.ok(w.workoutLibrary.getDraft());
});

test("an existing plan exposes editing and blank replacement without losing the active plan or draft", async (t) => {
  const original = record(alice, "Piano attuale");
  const { w, app } = await mount(t, { plans: new Map([[alice, original]]) });
  const edit = [...app.querySelectorAll("button")].find((button) => button.textContent === "Modifica piano");
  assert.ok(edit.classList.contains("btn-primary"));
  click(w, "Nuovo piano");
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
