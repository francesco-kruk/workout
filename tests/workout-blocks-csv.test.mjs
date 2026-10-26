import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { parseWorkoutCsv, readWorkoutCsv, exportWorkoutCsv, WORKOUT_CSV_HEADERS, WORKOUT_CSV_V3_HEADERS } = require("../assets/plan-csv.js");
const { validateWorkoutPlan, upgradeWorkoutPlan } = require("../assets/plan-validation.js");
const template = await readFile(new URL("../data/workout-blocks-template.csv", import.meta.url), "utf8");
const sources = new Map(await Promise.all(["ui", "plan-validation", "plan-csv", "tab-plan", "plan-editor"].map(async (name) =>
  [name, await readFile(new URL(`../assets/${name}.js`, import.meta.url), "utf8")])));
const movement = (id, name = id) => ({ id, name, target: "10 ripetizioni" });
const mixedPlan = () => ({
  version: 3, trackingId: "mixed-lineage", title: "Piano misto",
  warmup: [movement("mobility")],
  sessions: [{
    id: "day-a", label: "Giorno A", subtitle: "Misto", instructions: "Nell'ordine indicato",
    blocks: [
      { id: "strength", label: "Forza", type: "standard", exercises: [{ ...movement("squat"), sets: 3, optionalSets: 1, rest: 90, measurementMode: "reps", usesWeight: true }] },
      { id: "superset", label: "Superserie", type: "superset", rounds: 3, optionalRounds: 2, restSeconds: 60, exercises: [movement("row"), { ...movement("press"), measurementMode: "seconds", usesWeight: false }] },
      { id: "circuit", label: "Circuito", type: "amrap", durationMinutes: 12, legacyDayId: "day-a", exercises: [movement("burpees"), movement("lunges")] },
      { id: "emom", label: "EMOM", type: "emom", rounds: 4, minutes: [
        { id: "minute-a", exercises: [movement("pushups"), { ...movement("plank"), measurementMode: "seconds", usesWeight: false }] },
        { id: "minute-b", exercises: [{ ...movement("swing"), measurementMode: "reps", usesWeight: true }] },
      ] },
    ],
  }],
});
const legacyPlan = () => ({
  version: 2, title: "Scheda esistente", trackingId: "legacy-lineage", warmup: [],
  sessions: [{ id: "legacy-day", label: "Giorno esistente", type: "standard", exercises: [{ ...movement("legacy-squat", "Squat"), sets: 2, rest: 0 }] }],
});
const rowsOf = (plan, sourceVersionId = null) => exportWorkoutCsv(plan, { sourceVersionId }).replace(/^\uFEFF/, "").trim().split("\r\n").slice(1)
  .map((line) => Object.fromEntries(line.match(/"(?:[^"]|"")*"/g).map((cell, index) => [WORKOUT_CSV_V3_HEADERS[index], cell.slice(1, -1).replaceAll('""', '"')])));
const csv = (rows) => [WORKOUT_CSV_V3_HEADERS.join(","), ...rows.map((row) =>
  WORKOUT_CSV_V3_HEADERS.map((key) => `"${String(row[key] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
const allIds = (plan) => [plan.trackingId, ...plan.warmup.map((item) => item.id),
  ...plan.sessions.flatMap((day) => [day.id, ...day.blocks.flatMap((block) => [block.id,
    ...(block.type === "emom" ? block.minutes.flatMap((minute) => [minute.id, ...minute.exercises.map((item) => item.id)]) : block.exercises.map((item) => item.id))])])];
const content = (plan) => JSON.parse(JSON.stringify(plan, (key, value) => ["id", "trackingId", "legacyDayId"].includes(key) ? undefined : value));

test("v3 CSV has a separate header and mixed template, retaining the valid v2 template", async () => {
  assert.equal(WORKOUT_CSV_HEADERS.length, 17);
  assert.equal(WORKOUT_CSV_V3_HEADERS.length, 23);
  assert.deepEqual(WORKOUT_CSV_V3_HEADERS.slice(0, 17), WORKOUT_CSV_HEADERS);
  const plan = parseWorkoutCsv(template);
  assert.deepEqual(validateWorkoutPlan(plan), []);
  assert.deepEqual(plan.sessions[0].blocks.map((block) => block.type), ["standard", "superset", "amrap", "emom"]);
  assert.equal(plan.sessions[0].blocks[3].minutes.length, 2);
  assert.equal(plan.sessions[0].blocks[3].minutes[0].exercises.length, 2);
  assert.equal(plan.sessions[0].blocks[3].minutes[0].exercises[1].measurementMode, "seconds");
  const legacy = await readFile(new URL("../data/workout-plan-template.csv", import.meta.url), "utf8");
  assert.equal(parseWorkoutCsv(legacy).version, 2);
  const result = spawnSync(process.execPath, ["scripts/validate-plan.mjs", "data/workout-blocks-template.csv"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("v3 matching export round-trips all blocks, minute membership and explicit identities", () => {
  const original = mixedPlan();
  const baseRecord = { id: randomUUID(), definition: original };
  const source = exportWorkoutCsv(original, { sourceVersionId: baseRecord.id });
  const result = readWorkoutCsv(source, { baseRecord });
  assert.equal(result.preservesIdentity, true);
  assert.deepEqual(result.definition, original);
  assert.deepEqual(validateWorkoutPlan(result.definition), []);
  for (const trackingId of [undefined, "another-lineage"]) {
    const plan = mixedPlan();
    if (trackingId === undefined) delete plan.trackingId;
    else plan.trackingId = trackingId;
    const record = { id: randomUUID(), definition: plan };
    assert.deepEqual(readWorkoutCsv(exportWorkoutCsv(plan, { sourceVersionId: record.id }), { baseRecord: record }).definition, plan);
  }
});

test("new v3 imports always receive fresh namespaces and map converted AMRAP identity to the new day", () => {
  const original = mixedPlan();
  const source = exportWorkoutCsv(original, { sourceVersionId: randomUUID() });
  const first = readWorkoutCsv(source);
  const second = readWorkoutCsv(source);
  assert.equal(first.preservesIdentity, false);
  assert.deepEqual(content(first.definition), content(original));
  const oldIds = new Set(allIds(original));
  const firstIds = new Set(allIds(first.definition));
  assert.ok(allIds(first.definition).every((id) => !oldIds.has(id)));
  assert.ok(allIds(second.definition).every((id) => !firstIds.has(id)));
  assert.equal(first.definition.sessions[0].blocks[2].legacyDayId, first.definition.sessions[0].id);
  assert.notEqual(first.definition.sessions[0].blocks[2].legacyDayId, original.sessions[0].id);
});

test("parent rows can precede or follow children without changing ordered block, slot or member lists", () => {
  const original = mixedPlan();
  const rows = rowsOf(original);
  const order = ["exercise", "minute", "block", "warmup", "day", "plan"];
  const reordered = order.flatMap((kind) => rows.filter((row) => row.row_type === kind));
  assert.deepEqual(content(parseWorkoutCsv(csv(reordered))), content(original));
  const reversedBlocks = rows.filter((row) => row.row_type === "block").reverse();
  const edited = [...rows.filter((row) => row.row_type !== "block"), ...reversedBlocks];
  assert.deepEqual(parseWorkoutCsv(csv(edited)).sessions[0].blocks.map((block) => block.type), ["emom", "amrap", "superset", "standard"]);
  const reversedMinutes = rows.filter((row) => row.row_type === "minute").reverse();
  const minuteEdit = [...rows.filter((row) => row.row_type !== "minute"), ...reversedMinutes];
  assert.deepEqual(parseWorkoutCsv(csv(minuteEdit)).sessions[0].blocks[3].minutes.map((minute) => minute.exercises[0].name), ["swing", "pushups"]);
});

test("v3 CSV reversible spreadsheet protection includes multiline text, apostrophes and formulas", () => {
  for (const value of ["=1+1", "+SUM(A1)", "-42", "@command", "'literal", "''literal", "'=literal", "\ttext", "\ntext", "\rtext", "   =1", " -42", 'Comma, quote " and\nnewline']) {
    const plan = mixedPlan();
    plan.sessions[0].blocks[0].instructions = value;
    plan.sessions[0].blocks[3].minutes[0].exercises[0].instructions = value;
    const output = exportWorkoutCsv(plan);
    const result = parseWorkoutCsv(output);
    assert.equal(result.sessions[0].blocks[0].instructions, value);
    assert.equal(result.sessions[0].blocks[3].minutes[0].exercises[0].instructions, value);
    if (/^(?:['\t\r\n]|\s*[=+\-@])/.test(value)) assert.ok(output.includes(`"'${value.replaceAll('"', '""')}"`));
  }
  const source = exportWorkoutCsv(mixedPlan());
  assert.deepEqual(content(parseWorkoutCsv(source.replaceAll('","', '";"').replace(WORKOUT_CSV_V3_HEADERS.join(","), WORKOUT_CSV_V3_HEADERS.join(";")))), content(mixedPlan()));
});

test("v3 CSV rejects invalid kinds, orphan or mismatched references, duplicate keys and irrelevant data", () => {
  const source = rowsOf(mixedPlan());
  const mutate = (id, changes) => source.map((row) => row.row_id === id ? { ...row, ...changes } : row);
  for (const [rows, error] of [
    [source.filter((row) => row.row_type !== "plan"), /manca la riga plan/],
    [[...source, source[0]], /una sola riga plan/],
    [source.map((row) => row.row_type === "plan" ? { ...row, format_version: 2 } : row), /format_version/],
    [mutate("row", { row_type: "__proto__" }), /row_type/],
    [mutate("row", { block_key: "missing" }), /block_key.*non corrisponde/],
    [mutate("emom", { day_key: "missing" }), /day_key.*non corrisponde/],
    [mutate("minute-a", { day_key: "different" }), /day_key diverso/],
    [mutate("minute-a", { block_key: "day-1-block-1" }), /deve essere EMOM/],
    [mutate("pushups", { minute_key: "missing" }), /minute_key/],
    [mutate("pushups", { day_key: "different" }), /day_key diverso/],
    [mutate("row", { minute_key: "day-1-block-4-minute-1" }), /minute_key/],
    [[...source, { ...source.find((row) => row.row_id === "emom"), row_id: "" }], /block_key.*univoco/],
    [[...source, { ...source.find((row) => row.row_id === "minute-a"), row_id: "" }], /minute_key.*univoco/],
    [mutate("day-a", { session_type: "standard" }), /session_type.*non applicabile/],
    [mutate("strength", { rounds: "3" }), /rounds.*non applicabile/],
    [mutate("emom", { rest_seconds: "10" }), /rest_seconds.*non applicabile/],
    [mutate("circuit", { optional_rounds: "1" }), /optional_rounds.*non applicabile/],
    [mutate("row", { rest_seconds: "0" }), /superset.*recupero/],
    [mutate("press", { sets: "3" }), /superset/],
    [mutate("pushups", { optional_sets: "0" }), /emom/],
    [mutate("plank", { rest_seconds: "10" }), /emom/],
    [mutate("burpees", { measurement_mode: "reps" }), /AMRAP/],
    [mutate("burpees", { uses_weight: "false" }), /AMRAP/],
    [mutate("minute-a", { name: "Ignored minute name" }), /name.*non applicabile/],
    [mutate("mobility", { rounds: "2" }), /rounds.*non applicabile/],
    [mutate("circuit", { legacy_day_id: "other-day" }), /legacy_day_id/],
  ]) assert.throws(() => parseWorkoutCsv(csv(rows)), error);
});

test("v3 numeric and structural bounds never silently normalize invalid prescriptions", () => {
  const source = rowsOf(mixedPlan());
  const reject = (id, changes, error) => assert.throws(() => parseWorkoutCsv(csv(source.map((row) =>
    row.row_id === id ? { ...row, ...changes } : row))), error);
  for (const bad of ["", "-1", "1.5", "01", "1e2", " 3 ", "181"]) reject("emom", { rounds: bad }, /rounds|giri|durata/);
  for (const bad of ["", "0", "31"]) reject("superset", { rounds: bad }, /rounds|giri/);
  for (const bad of ["", "0", "181"]) reject("circuit", { duration_minutes: bad }, /duration_minutes|durata/);
  for (const bad of ["", "-1", "3601"]) reject("superset", { rest_seconds: bad }, /rest_seconds|recupero/);
  for (const bad of ["-1", "31"]) reject("superset", { optional_rounds: bad }, /optional_rounds|giri opzionali/);
  reject("squat", { rest_seconds: "" }, /recupero/);
  reject("squat", { sets: "" }, /serie/);
  reject("squat", { uses_weight: "yes" }, /uses_weight/);
  reject("plank", { measurement_mode: "guess" }, /tracciamento/);
  reject("emom", { rounds: "91" }, /durata EMOM/);
  assert.throws(() => parseWorkoutCsv(csv(source.filter((row) => row.row_id !== "row"))), /almeno 2/);
  assert.throws(() => parseWorkoutCsv(csv(source.filter((row) => row.row_id !== "swing"))), /esercizi/);
  const many = mixedPlan();
  many.sessions[0].blocks[3].minutes[0].exercises = Array.from({ length: 50 }, (_, index) => movement(`extra-${index}`));
  assert.throws(() => parseWorkoutCsv(exportWorkoutCsv(many)), /esercizi/);
});

test("v3 editing checks known row kinds and parent associations before preserving comparison identity", () => {
  const original = mixedPlan();
  original.sessions[0].blocks.push({ id: "other-emom", label: "Altro EMOM", type: "emom", rounds: 1, minutes: [{ id: "other-minute", exercises: [movement("other-move")] }] });
  const baseRecord = { id: randomUUID(), definition: original };
  const source = rowsOf(original, baseRecord.id);
  const change = (id, changes) => source.map((row) => row.row_id === id ? { ...row, ...changes } : row);
  for (const [rows, error] of [
    [source.map((row) => row.row_type === "plan" ? { ...row, source_version_id: randomUUID() } : row), /altra versione/],
    [source.map((row) => row.row_type === "plan" ? { ...row, tracking_id: "other" } : row), /tracking_id diverso/],
    [change("row", { row_id: "unknown" }), /non appartiene/],
    [change("row", { row_id: "__proto__" }), /row_id/],
    [change("row", { row_id: "press" }), /duplicato/],
    [source.map((row) => row.row_id === "other-minute" ? { ...row, row_id: "strength" } : ["strength", "squat"].includes(row.row_id) ? { ...row, row_id: "" } : row), /tipo di riga/],
    [change("minute-a", { block_key: "day-1-block-5" }).map((row) => ["pushups", "plank"].includes(row.row_id) ? { ...row, block_key: "day-1-block-5" } : row), /associazione/],
    [change("pushups", { minute_key: "day-1-block-4-minute-2" }), /associazione/],
    [change("row", { block_key: "day-1-block-1", sets: "2", rest_seconds: "0" }), /associazione/],
    [change("emom", { row_id: "" }), /associazione/],
    [change("circuit", { legacy_day_id: "not-original" }), /legacy_day_id/],
  ]) assert.throws(() => readWorkoutCsv(csv(rows), { baseRecord }), error);
  const moved = source.map((row) => ["minute-a", "pushups", "plank"].includes(row.row_id) ? { ...row, block_key: "day-1-block-5", row_id: "" } : row);
  const parsed = readWorkoutCsv(csv(moved), { baseRecord });
  assert.equal(parsed.preservesIdentity, true);
  assert.equal(parsed.definition.trackingId, original.trackingId);
  assert.ok(!allIds(parsed.definition).includes("minute-a"));
  assert.ok(!allIds(parsed.definition).includes("pushups"));
  assert.equal(parsed.definition.sessions[0].blocks[4].minutes.length, 2);
  const addition = { ...source.find((row) => row.row_id === "row"), row_id: "", name: "Nuovo movimento" };
  const added = readWorkoutCsv(csv([...source, addition]), { baseRecord });
  assert.equal(added.definition.sessions[0].blocks[1].exercises.at(-1).name, "Nuovo movimento");
});

test("legacy v2 editing also rejects cross-day or cross-format reuse of an exercise identity", () => {
  const original = legacyPlan();
  original.sessions.push({ id: "other-day", label: "Altro giorno", type: "standard", exercises: [{ ...movement("other-squat"), sets: 1, rest: 0 }] });
  const baseRecord = { id: randomUUID(), definition: original };
  const source = exportWorkoutCsv(original, { sourceVersionId: baseRecord.id });
  const moved = source.split("\r\n").map((line) => line.endsWith('"legacy-squat"') ? line.replace('"day-1"', '"day-2"') : line).join("\r\n");
  assert.throws(() => readWorkoutCsv(moved, { baseRecord }), /giornata o formato/);
});

function mountEditor(t, original = legacyPlan()) {
  const dom = new JSDOM("<main id='editor'></main>", { url: "https://example.test/workout/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.console.error = () => {};
  w.createButton = (label, className) => {
    const button = w.document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = className;
    return button;
  };
  w.getExerciseTracking = (exercise) => ({ mode: exercise.measurementMode || "reps", usesWeight: exercise.usesWeight || false });
  w.formatExerciseTracking = () => "Tracciamento esercizio";
  w.getCurrentSessionId = (plan) => plan.sessions[0].id;
  w.renderDay = (parent, plan) => { parent.textContent = plan.title; };
  const state = { userId: "alice", record: { id: randomUUID(), definition: structuredClone(original) }, plan: structuredClone(original) };
  let draft = null;
  const saved = [];
  w.workoutSocial = { snapshot: () => ({ member: { userId: "alice" } }) };
  w.workoutLibrary = {
    snapshot: () => state, getDraft: () => draft,
    writeDraft: (definition, baseVersionId) => (draft = { definition, baseVersionId, versionId: randomUUID() }),
    discardDraft: () => { draft = null; }, getLegacyDraft: () => null,
    save: async (candidate) => {
      saved.push(structuredClone(candidate));
      state.record = { id: candidate.versionId, definition: structuredClone(candidate.definition) };
      state.plan = state.record.definition;
      draft = null;
    },
    template: () => structuredClone(original),
  };
  for (const name of ["ui", "plan-validation", "plan-csv", "tab-plan", "plan-editor"]) w.eval(sources.get(name));
  const app = w.document.querySelector("#editor");
  const cleanup = w.renderPersonalPlan(app);
  const click = (label, parent = app) => {
    const button = [...parent.querySelectorAll("button")].find((button) => button.textContent === label && !button.closest(".wizard-panel[hidden]"));
    assert.ok(button, `Visible button missing: ${label}`);
    assert.equal(button.disabled, false, `Button disabled: ${label}`);
    button.click();
  };
  const visible = () => app.querySelector(".wizard-panel:not([hidden])");
  const input = (label, value, parent = visible()) => {
    const wrapper = [...parent.querySelectorAll("label")].find((element) => element.firstChild.textContent === label);
    assert.ok(wrapper, `Field missing: ${label}`);
    const element = wrapper.querySelector("input,textarea,select");
    element.value = value;
    element.dispatchEvent(new w.Event("input", { bubbles: true }));
    return element;
  };
  const edit = () => { click("Modifica piano"); click("Usa Manuale"); };
  return { w, app, state, saved, click, input, visible, edit, cleanup, draft: () => draft };
}

test("Manual conversion is explicit, draft-only and preserves legacy selectors, IDs and tracking", (t) => {
  const editor = mountEditor(t);
  editor.edit();
  assert.equal(editor.draft().definition.version, 2);
  editor.click("Continua alle giornate");
  assert.ok(editor.visible().querySelector("select"));
  editor.click("Aggiungi blocchi / Usa blocchi misti");
  assert.equal(editor.draft().definition.version, 3);
  assert.equal(editor.draft().definition.trackingId, "legacy-lineage");
  assert.equal(editor.draft().definition.sessions[0].id, "legacy-day");
  assert.equal(editor.draft().definition.sessions[0].blocks[0].exercises[0].id, "legacy-squat");
  assert.equal(editor.state.record.definition.version, 2);
  assert.equal(editor.saved.length, 0);
  assert.equal(editor.w.localStorage.length, 0);
  editor.click("Annulla");
  assert.equal(editor.draft(), null);
  editor.edit();
  assert.equal(editor.draft().definition.version, 2);
});

test("Manual mixed wizard creates, edits, reorders and removes blocks, minute slots and member exercises then explicitly saves", async (t) => {
  const editor = mountEditor(t);
  const { click, input, visible } = editor;
  editor.edit();
  click("Usa blocchi misti");
  click("Aggiungi blocco Superserie");
  input("Nome blocco", "Superserie modificata");
  input("Giri obbligatori", "4");
  input("Giri opzionali", "1");
  input("Recupero dopo il giro (secondi)", "90");
  let groups = [...visible().querySelectorAll("fieldset[data-exercise]")];
  input("Nome esercizio", "Rematore", groups[0]);
  input("Obiettivo / ripetizioni", "10", groups[0]);
  input("Nome esercizio", "Distensioni", groups[1]);
  input("Obiettivo / ripetizioni", "8", groups[1]);
  assert.equal(groups[0].querySelector('input[type="number"]'), null);
  click("Aggiungi esercizio");
  groups = [...visible().querySelectorAll("fieldset[data-exercise]")];
  input("Nome esercizio", "Da eliminare", groups[2]);
  input("Obiettivo / ripetizioni", "1", groups[2]);
  click("Sposta su", groups[1]);
  assert.equal(editor.draft().definition.sessions[0].blocks[1].exercises[0].name, "Distensioni");
  groups = [...visible().querySelectorAll("fieldset[data-exercise]")];
  click("Rimuovi", groups[2]);
  assert.equal(editor.draft().definition.sessions[0].blocks[1].exercises.length, 2);
  click("Completa blocco");
  click("Aggiungi blocco AMRAP");
  input("Nome esercizio", "Burpees");
  input("Obiettivo / ripetizioni", "5");
  input("Durata AMRAP (minuti)", "8");
  assert.equal(visible().querySelector("select"), null);
  click("Completa blocco");
  click("Aggiungi blocco EMOM");
  input("Giri EMOM", "3");
  input("Nome esercizio", "Piegamenti");
  input("Obiettivo / ripetizioni", "6");
  click("Aggiungi esercizio");
  groups = [...visible().querySelectorAll("fieldset[data-exercise]")];
  input("Nome esercizio", "Plank", groups[1]);
  input("Obiettivo / ripetizioni", "20 secondi", groups[1]);
  click("Aggiungi minuto");
  let slots = [...visible().querySelectorAll("fieldset[data-minute]")];
  input("Nome esercizio", "Swing", slots[1]);
  input("Obiettivo / ripetizioni", "12", slots[1]);
  assert.match(visible().textContent, /2 slot da 60 secondi × 3 giri = 6 minuti/);
  const minuteButtons = slots[1].querySelectorAll(":scope > .editor-actions button");
  minuteButtons[0].click();
  let emom = editor.draft().definition.sessions[0].blocks[3];
  assert.equal(emom.minutes[0].exercises[0].name, "Swing");
  assert.equal(emom.minutes[1].exercises.length, 2);
  click("Aggiungi minuto");
  slots = [...visible().querySelectorAll("fieldset[data-minute]")];
  slots[2].querySelectorAll(":scope > .editor-actions button")[2].click();
  assert.equal(editor.draft().definition.sessions[0].blocks[3].minutes.length, 2);
  click("Completa blocco");
  const summaries = [...visible().querySelectorAll("[data-block-summary]")];
  click("Sposta su", summaries[3]);
  assert.deepEqual(Array.from(editor.draft().definition.sessions[0].blocks, (block) => block.type), ["standard", "superset", "emom", "amrap"]);
  assert.equal(editor.saved.length, 0);
  click("3. Rivedi piano");
  assert.equal(visible().dataset.screen, "review");
  assert.match(visible().textContent, /Superserie modificata|Swing|Durata AMRAP: 8 minuti/);
  click("Salva piano");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(editor.saved.length, 1);
  assert.deepEqual(validateWorkoutPlan(editor.saved[0].definition), []);
  assert.equal(editor.saved[0].definition.sessions[0].blocks[1].rounds, 4);
  assert.equal(editor.state.record.definition.version, 3);
});

test("Manual mixed review reveals invalid format fields and supports cancellation, pagehide and tab cleanup", (t) => {
  for (const discard of ["cancel", "pagehide", "cleanup"]) {
    const editor = mountEditor(t, mixedPlan());
    editor.edit();
    editor.click("Continua alle giornate");
    const summary = editor.visible().querySelector('[data-block-summary="superset"]');
    editor.click("Modifica blocco", summary);
    const rounds = editor.input("Giri obbligatori", "0");
    editor.click("3. Rivedi piano");
    assert.equal(editor.visible().dataset.screen, "block");
    assert.equal(editor.w.document.activeElement, rounds);
    assert.equal(rounds.getAttribute("aria-invalid"), "true");
    assert.equal(editor.saved.length, 0);
    if (discard === "cancel") editor.click("Annulla");
    else if (discard === "pagehide") editor.w.dispatchEvent(new editor.w.PageTransitionEvent("pagehide", { persisted: true }));
    else editor.cleanup();
    assert.equal(editor.draft(), null);
    assert.equal(editor.state.record.definition.sessions[0].blocks[1].rounds, 3);
    assert.equal(editor.w.localStorage.length, 0);
  }
});

test("Manual mixed editor enforces total exercise and minute budgets, keeps stable reordered slot IDs", (t) => {
  const plan = mixedPlan();
  const minute = plan.sessions[0].blocks[3].minutes[0];
  plan.sessions[0].blocks = [{ id: "emom", label: "EMOM", type: "emom", rounds: 1,
    minutes: Array.from({ length: 50 }, (_, index) => ({ id: `minute-${index}`, exercises: [{ ...minute.exercises[0], id: `movement-${index}` }] })) }];
  const editor = mountEditor(t, plan);
  editor.edit();
  editor.click("Continua alle giornate");
  for (const button of editor.visible().querySelectorAll("button")) {
    if (button.textContent.startsWith("Aggiungi blocco")) assert.equal(button.disabled, true);
  }
  editor.click("Modifica blocco");
  for (const button of editor.visible().querySelectorAll("button")) {
    if (["Aggiungi minuto", "Aggiungi esercizio"].includes(button.textContent)) assert.equal(button.disabled, true);
  }
  const second = editor.visible().querySelectorAll("fieldset[data-minute]")[1];
  second.querySelector(":scope > .editor-actions button").click();
  assert.equal(editor.draft().definition.sessions[0].blocks[0].minutes[0].id, "minute-1");
});

test("new Manual plans offer visible mixed authoring, block removal and day/warmup editing without saving early", (t) => {
  const editor = mountEditor(t);
  const { click, input, visible } = editor;
  click("Nuovo piano");
  click("Usa Manuale");
  click("Usa blocchi misti");
  input("Nome giornata", "Nuovo giorno misto");
  click("Modifica blocco");
  input("Nome blocco", "Prima parte");
  input("Nome esercizio", "Squat");
  input("Obiettivo / ripetizioni", "10");
  input("Recupero (secondi)", "0");
  click("Completa blocco");
  click("Aggiungi blocco AMRAP");
  click("Indietro");
  const blocks = visible().querySelectorAll("[data-block-summary]");
  click("Rimuovi", blocks[1]);
  assert.equal(editor.draft().definition.sessions[0].blocks.length, 1);
  click("2. Giornate");
  click("Aggiungi giornata");
  input("Nome giornata", "Seconda giornata");
  click("2. Giornate");
  const days = visible().querySelectorAll("[data-day]");
  click("Sposta su", days[1]);
  assert.equal(editor.draft().definition.sessions[0].label, "Seconda giornata");
  click("Rimuovi", visible().querySelectorAll("[data-day]")[0]);
  click("1. Dettagli");
  click("Aggiungi riscaldamento");
  input("Nome", "Mobilità");
  input("Obiettivo", "5 minuti");
  click("Rimuovi", visible().querySelector("fieldset"));
  assert.equal(editor.draft().definition.warmup.length, 0);
  click("3. Rivedi piano");
  assert.equal(visible().dataset.screen, "review");
  assert.deepEqual(validateWorkoutPlan(editor.draft().definition), []);
  assert.equal(editor.saved.length, 0);
  assert.equal(editor.state.record.definition.version, 2);
  assert.equal(editor.w.localStorage.length, 0);
});

test("changing EMOM rounds immediately updates minute-slot availability within the 180-minute limit", (t) => {
  const plan = mixedPlan();
  const emom = plan.sessions[0].blocks[3];
  emom.minutes.splice(1);
  emom.rounds = 180;
  const editor = mountEditor(t, plan);
  editor.edit();
  editor.click("Continua alle giornate");
  editor.click("Modifica blocco", editor.visible().querySelector('[data-block-summary="emom"]'));
  const add = editor.visible().querySelector("[data-add-minute]");
  assert.equal(add.disabled, true);
  editor.input("Giri EMOM", "3");
  assert.equal(add.disabled, false);
  editor.click("Aggiungi minuto");
  assert.equal(editor.draft().definition.sessions[0].blocks[3].minutes.length, 2);
  const rounds = editor.input("Giri EMOM", "91");
  editor.click("3. Rivedi piano");
  assert.equal(rounds.getAttribute("aria-invalid"), "true");
  assert.equal(editor.visible().dataset.screen, "block");
});

test("Manual and CSV conversion preserve compatible legacy AMRAP identity without mutating the source", (t) => {
  const original = legacyPlan();
  original.sessions[0] = { id: "legacy-day", label: "Circuito", type: "amrap", duration: "10 minuti",
    exercises: [{ ...movement("legacy-amrap"), rest: 30, sets: 3, measurementMode: "reps" }] };
  const snapshot = structuredClone(original);
  const upgraded = upgradeWorkoutPlan(original);
  assert.deepEqual(original, snapshot);
  assert.equal(upgraded.sessions[0].blocks[0].legacyDayId, "legacy-day");
  assert.deepEqual(validateWorkoutPlan(upgraded), []);
  const record = { id: randomUUID(), definition: upgraded };
  const canonical = JSON.parse(JSON.stringify(upgraded, (_key, value) => value === "" ? undefined : value));
  assert.deepEqual(readWorkoutCsv(exportWorkoutCsv(upgraded, { sourceVersionId: record.id }), { baseRecord: record }).definition, canonical);
  const editor = mountEditor(t, original);
  editor.edit();
  editor.click("Usa blocchi misti");
  assert.equal(editor.draft().definition.sessions[0].blocks[0].legacyDayId, "legacy-day");
  assert.deepEqual(JSON.parse(JSON.stringify(editor.state.record.definition)), original);
});
