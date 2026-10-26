import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { validateWorkoutPlan, upgradeWorkoutPlan, getSessionBlocks, workoutJsonbSize } = require("../assets/plan-validation.js");
const example = JSON.parse(await readFile(new URL("../data/workout-blocks-example.json", import.meta.url)));
const source = new Map(await Promise.all([
  "plan-validation", "state", "attendance", "ui", "tab-plan", "tab-day", "tab-progress",
  "timed-blocks", "tab-workout", "workout-library",
].map(async (name) => [name, await readFile(new URL(`../assets/${name}.js`, import.meta.url), "utf8")])));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("result size preflight includes database JSONB separators at the exact limit", () => {
  const value = { a: { reps: 8, notes: "x" }, b: [null, "quoted\ntext"] };
  assert.equal(workoutJsonbSize(value), '{"a": {"reps": 8, "notes": "x"}, "b": [null, "quoted\\ntext"]}'.length);
  const remaining = 200000 - workoutJsonbSize(value);
  value.a.notes += "x".repeat(remaining);
  assert.equal(workoutJsonbSize(value), 200000);
  assert.ok(JSON.stringify(value).length < 200000);
  value.a.notes += "x";
  assert.equal(workoutJsonbSize(value), 200001);
});

async function setup(t) {
  const dom = new JSDOM("<main></main>", { url: "http://localhost/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.scrollTo = () => {};
  w.console.error = () => {};
  for (const script of source.values()) w.eval(script);
  const plan = structuredClone(example);
  const receipts = [];
  const record = { id: "11111111-1111-4111-8111-111111111111", revision: 1, user_id: "owner", definition: plan };
  w.workoutSocial = {
    snapshot: () => ({ user: { id: "owner" }, member: {}, error: "" }),
    fetchPersonalPlan: async () => record,
    recordCompletion: (runId, workout) => { receipts.push(workout); w.recordAttendance(runId, "owner", undefined, workout); },
    fetchPrevious: async () => null,
    completionMessage: () => "",
  };
  w.workoutLibrary.start(plan);
  await w.workoutLibrary.load();
  w.clearProgress("mixed-day");
  const container = w.document.querySelector("main");
  let now = 1000000;
  w.Date.now = () => now;
  const advance = (ms) => { now += ms; };
  return { w, container, plan, receipts, advance };
}

function click(w, container, label) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  assert.ok(button, `Missing ${label}`);
  assert.equal(button.disabled, false, `${label} disabled`);
  button.click();
}

test("version-3 example and legacy conversion preserve definitions and identities", () => {
  assert.deepEqual(validateWorkoutPlan(example), []);
  const legacy = { version: 2, title: "Legacy", warmup: [], sessions: [
    { id: "old", label: "AMRAP", type: "amrap", duration: "20 minuti",
      exercises: [{ id: "push", name: "Push", target: "5" }] },
  ] };
  const upgraded = upgradeWorkoutPlan(legacy);
  assert.equal(legacy.version, 2);
  assert.equal(getSessionBlocks(legacy.sessions[0])[0].id, "old");
  assert.deepEqual(validateWorkoutPlan(upgraded), []);
  assert.equal(upgraded.sessions[0].id, "old");
  assert.equal(upgraded.sessions[0].blocks[0].legacyDayId, "old");
  assert.equal(upgraded.sessions[0].blocks[0].exercises[0].id, "push");
});

test("strict block fields, identity, duration and expanded-work boundaries", () => {
  for (const mutate of [
    (p) => { p.sessions[0].blocks[1].rounds = 0; },
    (p) => { p.sessions[0].blocks[1].exercises.pop(); },
    (p) => { p.sessions[0].blocks[1].exercises[0].rest = 0; },
    (p) => { p.sessions[0].blocks[2].exercises[0].measurementMode = "reps"; },
    (p) => { p.sessions[0].blocks[3].rounds = 91; },
    (p) => { p.sessions[0].blocks[3].minutes[0].id = "mixed-day"; },
    (p) => { p.sessions[0].blocks[0].blocks = []; },
    (p) => { p.sessions[0].blocks[2].durationMinutes = 1.5; },
  ]) {
    const plan = structuredClone(example);
    mutate(plan);
    assert.ok(validateWorkoutPlan(plan).length);
  }
  for (const [rounds, valid] of [[90, true], [91, false]]) {
    const plan = structuredClone(example);
    plan.sessions[0].blocks[3].rounds = rounds;
    assert.equal(validateWorkoutPlan(plan).length === 0, valid);
  }
  const boundary = structuredClone(example);
  const block = boundary.sessions[0].blocks[3];
  block.rounds = 30;
  block.minutes = [{ id: "only-minute", exercises: Array.from({ length: 50 }, (_, i) => ({
    id: `work-${i}`, name: `Movimento ${i}`, target: "5", measurementMode: "reps",
  })) }];
  boundary.sessions[0].blocks = [block];
  assert.deepEqual(validateWorkoutPlan(boundary), []);
  boundary.warmup.push({ id: "warm", name: "Mobilità", target: "5" });
  assert.ok(validateWorkoutPlan(boundary).some((error) => error.includes("1500")));
});

test("superset steps interleave rounds and recover only at round boundaries", async (t) => {
  const { w, container, plan } = await setup(t);
  const day = plan.sessions[0];
  day.blocks = [day.blocks[1], day.blocks[2]];
  day.blocks[0].rounds = 2;
  day.blocks[0].optionalRounds = 0;
  const steps = w.getWorkoutSteps(plan, day);
  assert.deepEqual(plain(steps.map((s) => s.key)), [
    "superset-push:0", "superset-row:0", "superset-push:1", "superset-row:1", "amrap-block:amrap",
  ]);
  const dispose = w.renderWorkout(container, plan);
  function enter(selector, value) {
    const input = container.querySelector(selector);
    assert.ok(input);
    input.value = value;
    input.dispatchEvent(new w.Event("input"));
  }
  assert.match(container.textContent, /Nessun recupero. Prossimo: Rematore/);
  enter('[data-actual-field="reps"]', "8");
  click(w, container, "Serie completata");
  assert.equal(w.getProgress(day.id).restTimer, null);
  assert.match(container.textContent, /Rematore/);
  enter('[data-actual-field="reps"]', "10");
  enter('[data-actual-field="weightKg"]', "12");
  click(w, container, "Serie completata");
  assert.equal(w.getProgress(day.id).restTimer.durationSeconds, 60);
  click(w, container, "Salta recupero");
  assert.match(container.textContent, /giro 2 di 2/);
  assert.equal(w.getProgress(day.id).results["superset-row:0"].weightKg, "12");
  dispose();
});

test("EMOM clock advances without fabricating results and reconciles missed minutes", async (t) => {
  const { w, container, plan, advance } = await setup(t);
  const block = plan.sessions[0].blocks[3];
  block.rounds = 1;
  const step = { type: "emom", key: `${block.id}:emom`, block, session: plan.sessions[0] };
  let complete = 0;
  const view = w.renderTimedBlock(step, { refresh: () => {}, complete: () => complete++ });
  t.after(view.dispose);
  container.appendChild(view.element);
  assert.match(container.textContent, /Squat/);
  assert.match(container.textContent, /Piegamenti/);
  assert.ok(container.querySelector('[aria-label="Rivedi minuto EMOM"]').disabled);
  click(w, container, "Avvia timer");
  click(w, container, "Minuto completato");
  assert.match(container.textContent, /Recupero fino al prossimo minuto/);
  advance(60000);
  view.refresh();
  assert.match(container.textContent, /minuto 2 di 2/);
  assert.equal(w.getBlockProgress("mixed-day", block).minutes[1], undefined);
  click(w, container, "Minuto mancato");
  advance(60000);
  view.refresh();
  click(w, container, "Completa EMOM");
  assert.equal(complete, 1);
  const result = plain(w.blockCompletionResults({ blocks: [block] }, w.getProgress("mixed-day")));
  assert.deepEqual(result[block.id].minutes, {
    0: { status: "completed", measurements: {} },
    1: { status: "missed", measurements: {} },
  });
});

test("timed blocks survive view disposal/reload and pause without losing the schedule", async (t) => {
  const { w, container, plan, advance } = await setup(t);
  const block = plan.sessions[0].blocks[3];
  const step = { type: "emom", key: `${block.id}:emom`, block, session: plan.sessions[0] };
  const view = w.renderTimedBlock(step, { refresh: () => {}, complete: () => {} });
  container.appendChild(view.element);
  click(w, container, "Avvia timer");
  advance(130000);
  view.dispose();
  container.replaceChildren();
  const restored = w.renderTimedBlock(step, { refresh: () => {}, complete: () => {} });
  t.after(restored.dispose);
  container.appendChild(restored.element);
  assert.match(container.textContent, /minuto 3 di 6/);
  assert.deepEqual(plain(w.getBlockProgress("mixed-day", block).minutes || {}), {});
  click(w, container, "Pausa");
  const paused = w.timedBlockClock(block, w.getBlockProgress("mixed-day", block)).remaining;
  advance(300000);
  restored.refresh();
  assert.equal(w.timedBlockClock(block, w.getBlockProgress("mixed-day", block)).remaining, paused);
  click(w, container, "Riprendi");
  advance(paused);
  restored.refresh();
  assert.match(container.textContent, /Tempo terminato/);
  assert.ok([...container.querySelectorAll("button")].find((b) => b.textContent === "Completa EMOM").disabled);
});

test("AMRAP blocks are isolated and final receipts retain missed EMOM minutes", async (t) => {
  const { w, plan, receipts } = await setup(t);
  const day = plan.sessions[0];
  day.blocks = [day.blocks[2], day.blocks[3]];
  for (const block of day.blocks) {
    w.updateBlockProgress(day.id, block.id, { timer: { deadline: w.Date.now() - 1, remainingMilliseconds: 0 },
      ...(block.type === "amrap" ? { rounds: 4, extraReps: "3" } : {
        minutes: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, { status: "missed", measurements: {} }])),
      }) });
    w.applyWorkoutProgress(plan, day.id, () => w.setStepStatus(day.id, `${block.id}:${block.type}`, "completed"));
  }
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].payloadVersion, 3);
  assert.deepEqual(plain(receipts[0].blockResults["amrap-block"]), { rounds: 4, extraReps: 3 });
  assert.equal(receipts[0].blockResults["emom-block"].minutes[0].status, "missed");
  w.undoLastStep(day.id);
  w.applyWorkoutProgress(plan, day.id, () => w.setStepStatus(day.id, "emom-block:emom", "completed"));
  assert.equal(receipts.length, 1);
  assert.equal(w.pendingAttendance("owner").length, 1);
});

test("EMOM optional measurements validate independently and marking missed clears them", async (t) => {
  const { w, container, plan, advance } = await setup(t);
  const block = plan.sessions[0].blocks[3];
  block.rounds = 1;
  const step = { type: "emom", key: `${block.id}:emom`, block, session: plan.sessions[0] };
  const view = w.renderTimedBlock(step, { refresh: () => {}, complete: () => {} });
  container.appendChild(view.element);
  click(w, container, "Avvia timer");
  click(w, container, "Minuto completato");
  const measurement = container.querySelector(".emom-measurements input");
  measurement.value = "8";
  measurement.dispatchEvent(new w.Event("input"));
  assert.equal(w.getBlockProgress("mixed-day", block).minutes[0].measurements["emom-squat"].reps, "8");
  measurement.value = "1.5";
  measurement.dispatchEvent(new w.Event("input"));
  assert.match(container.querySelector('[role="alert"]').textContent, /intero/);
  advance(120000);
  view.refresh();
  assert.match(container.querySelector('[role="alert"]').textContent, /intero/);
  click(w, container, "Minuto mancato");
  assert.throws(() => w.blockCompletionResults({ blocks: [block] }, w.getProgress("mixed-day")), /Minuto 1, Squat/);
  const select = container.querySelector("select");
  select.value = "0";
  select.dispatchEvent(new w.Event("change"));
  click(w, container, "Minuto mancato");
  const result = w.blockCompletionResults({ blocks: [block] }, w.getProgress("mixed-day"));
  assert.deepEqual(plain(result[block.id].minutes[0].measurements), {});
  view.dispose();
});

test("optional superset rounds skip and undo as a coherent group", async (t) => {
  const { w, container, plan } = await setup(t);
  const block = plan.sessions[0].blocks[1];
  block.rounds = 1;
  block.optionalRounds = 1;
  const day = plan.sessions[0];
  day.blocks = [block];
  for (const exercise of block.exercises) {
    w.updateSetResult(day.id, `${exercise.id}:0`, { reps: "8", weightKg: "10" });
    w.setStepStatus(day.id, `${exercise.id}:0`, "completed");
  }
  const dispose = w.renderWorkout(container, plan);
  click(w, container, "Salta giro opzionale");
  assert.equal(w.getProgress(day.id).steps["superset-push:1"], "skipped");
  assert.equal(w.getProgress(day.id).steps["superset-row:1"], "skipped");
  w.undoLastStep(day.id, plan);
  assert.equal(w.getProgress(day.id).steps["superset-push:1"], undefined);
  assert.equal(w.getProgress(day.id).steps["superset-row:1"], undefined);
  dispose();
});

test("invalid final snapshots roll progress back and do not create a durable receipt", async (t) => {
  const { w, plan, receipts } = await setup(t);
  const day = plan.sessions[0];
  day.blocks = [day.blocks[2]];
  const block = day.blocks[0];
  w.updateBlockProgress(day.id, block.id, { timer: { deadline: null, remainingMilliseconds: 0 }, rounds: "invalid" });
  assert.throws(() => w.applyWorkoutProgress(plan, day.id, () =>
    w.setStepStatus(day.id, `${block.id}:amrap`, "completed")), /Giri completi/);
  assert.equal(w.getProgress(day.id).steps[`${block.id}:amrap`], undefined);
  assert.equal(receipts.length, 0);
  assert.deepEqual(plain(w.pendingAttendance("owner")), []);
});

test("separate AMRAP blocks keep independent running and paused clocks", async (t) => {
  const { w, plan, advance } = await setup(t);
  const first = plan.sessions[0].blocks[2];
  const second = { ...structuredClone(first), id: "second-amrap" };
  w.updateBlockProgress("mixed-day", first.id, {
    timer: { deadline: w.Date.now() + 600000, remainingMilliseconds: 600000 }, rounds: 2, extraReps: "5",
  });
  w.updateBlockProgress("mixed-day", second.id, {
    timer: { deadline: null, remainingMilliseconds: 120000 }, rounds: 7, extraReps: "1",
  });
  advance(70000);
  assert.equal(w.timedBlockClock(first, w.getBlockProgress("mixed-day", first)).remaining, 530000);
  assert.equal(w.timedBlockClock(second, w.getBlockProgress("mixed-day", second)).remaining, 120000);
  assert.equal(w.getBlockProgress("mixed-day", first).rounds, 2);
  assert.equal(w.getBlockProgress("mixed-day", second).rounds, 7);
  w.setWorkoutScope("another-owner", "another-plan");
  assert.deepEqual(plain(w.getBlockProgress("mixed-day", first)), {});
});

test("oversized actual results are rejected locally before a completion receipt exists", async (t) => {
  const { w, plan, receipts } = await setup(t);
  const day = plan.sessions[0];
  day.blocks = [{ id: "large-standard", label: "Serie", type: "standard",
    exercises: Array.from({ length: 10 }, (_, i) => ({
      id: `exercise-${i}`, name: "Esercizio", target: "5", sets: 30, rest: 0,
    })) }];
  const steps = w.getWorkoutSteps(plan, day);
  const last = steps.at(-1).key;
  const progress = {
    runId: "large-run",
    steps: Object.fromEntries(steps.slice(0, -1).map((step) => [step.key, "completed"])),
    history: steps.slice(0, -1).map((step) => step.key),
    results: Object.fromEntries(steps.map((step) => [step.key, { reps: 5, notes: "x".repeat(1000) }])),
  };
  w.writeProgressStore({ version: 2, sessions: { [day.id]: progress } });
  assert.throws(() => w.applyWorkoutProgress(plan, day.id, () =>
    w.setStepStatus(day.id, last, "completed")), /200000/);
  assert.equal(w.getProgress(day.id).steps[last], undefined);
  assert.equal(receipts.length, 0);
});

test("recovering a manual completion pauses timed block clocks without discarding their results", async (t) => {
  const { w, plan, advance } = await setup(t);
  const block = plan.sessions[0].blocks[3];
  w.updateBlockProgress("mixed-day", block.id, {
    timer: { deadline: w.Date.now() + 360000, remainingMilliseconds: 360000 },
    minutes: { 0: { status: "completed", measurements: {} } },
  });
  advance(30000);
  w.applyManualWorkoutProgress(plan, {
    id: "manual-recovery", sessionId: "mixed-day",
    runId: w.getProgress("mixed-day").runId, replacesPlanned: false,
  });
  const saved = w.getBlockProgress("mixed-day", block);
  assert.equal(saved.timer.deadline, null);
  assert.equal(saved.timer.remainingMilliseconds, 330000);
  assert.equal(saved.minutes[0].status, "completed");
  advance(360000);
  assert.equal(w.timedBlockClock(block, w.getBlockProgress("mixed-day", block)).remaining, 330000);
});
