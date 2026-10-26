import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { parseWorkoutCsv, readWorkoutCsv, exportWorkoutCsv, WORKOUT_CSV_HEADERS, WORKOUT_CSV_LEGACY_HEADERS } = require("../assets/plan-csv.js");
const { validateWorkoutPlan } = require("../assets/plan-validation.js");
const template = await readFile(new URL("../data/workout-plan-template.csv", import.meta.url), "utf8");
const base = () => ({
  version: 2, title: "Scheda", warmup: [],
  sessions: [{ id: "day", label: "Giorno A", type: "standard", exercises: [
    { id: "exercise", name: "Squat", target: "8-12", sets: 3, rest: 0 },
  ] }],
});
const csv = (...rows) => [WORKOUT_CSV_HEADERS.join(","), ...rows.map((row) => WORKOUT_CSV_HEADERS.map((key) => {
  const value = String(row[key] ?? "");
  return `"${value.replace(/"/g, '""')}"`;
}).join(","))].join("\n");
const metadata = { row_type: "plan", format_version: 2, name: "Scheda" };
const day = { row_type: "day", day_key: "A", name: "Giorno A", session_type: "standard" };
const exercise = { row_type: "exercise", day_key: "A", name: "Squat", target: "10", sets: 3, rest_seconds: 0 };

test("template and legacy CSV validate using the shared contract and CLI", () => {
  assert.deepEqual(validateWorkoutPlan(parseWorkoutCsv(template)), []);
  const legacy = csv(metadata, day, exercise).split("\n").map((row, index) =>
    index === 0 ? WORKOUT_CSV_LEGACY_HEADERS.join(",") : row.split(",").slice(0, 14).join(",")
  ).join("\n").replace('"plan","2"', '"plan","1"');
  assert.deepEqual(validateWorkoutPlan(parseWorkoutCsv(legacy)), []);
  for (const args of [[], ["data/workout-plan-template.csv"], ["data/workout-plan.json"]]) {
    const result = spawnSync(process.execPath, ["scripts/validate-plan.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("CSV round-trip preserves content, explicit tracking, warm-up, ordering and fresh IDs", () => {
  const first = parseWorkoutCsv(template);
  first.title = 'Piano "A", forza';
  first.sessions[0].instructions = "Prima riga\nSeconda riga; dettagli";
  first.sessions[0].exercises[0].optionalSets = 2;
  first.sessions[1].exercises[0].rest = 30;
  const second = parseWorkoutCsv(exportWorkoutCsv(first));
  const content = (plan) => JSON.parse(JSON.stringify(plan, (key, value) => ["id", "trackingId"].includes(key) ? undefined : value));
  assert.deepEqual(content(second), content(first));
  assert.notEqual(second.sessions[0].id, first.sessions[0].id);
  assert.notEqual(second.sessions[0].exercises[0].id, first.sessions[0].exercises[0].id);
  assert.deepEqual(parseWorkoutCsv(exportWorkoutCsv(base())).warmup, []);
});

test("BOM, semicolon, CRLF, quoted delimiters, newlines, escaped quotes and trailing blank records", () => {
  const source = csv(metadata, { ...day, name: 'Forza; "A"' }, { ...exercise, instructions: "Riga 1\nRiga 2" });
  const semicolon = "\uFEFF" + source.replaceAll('","', '";"').replace(WORKOUT_CSV_HEADERS.join(","), WORKOUT_CSV_HEADERS.join(";")) + "\r\n\r\n";
  const parsed = parseWorkoutCsv(semicolon);
  assert.equal(parsed.sessions[0].label, 'Forza; "A"');
  assert.equal(parsed.sessions[0].exercises[0].instructions, "Riga 1\nRiga 2");
  assert.equal(parseWorkoutCsv(source.replaceAll("\n", "\r\n")).sessions.length, 1);
});

test("spreadsheet-protected text is reversible, including apostrophes and leading whitespace", () => {
  for (const value of ["=1+1", "+SUM(A1)", "-42", "@command", "'literal", "''literal", "'=literal", "\ttext", "\ntext", "\rtext", "   =1", "\v=1", "\uFEFF=1", " -42", "Normal text", "l'apostrofo"]) {
    const plan = base();
    plan.sessions[0].exercises[0].instructions = value;
    const output = exportWorkoutCsv(plan);
    assert.equal(parseWorkoutCsv(output).sessions[0].exercises[0].instructions, value);
    if (/^(?:['\t\r\n]|\s*[=+\-@])/.test(value)) assert.ok(output.includes(`"'${value.replaceAll('"', '""')}"`));
  }
});

test("exercises resolve earlier or later day references and preserve within-day order", () => {
  const parsed = parseWorkoutCsv(csv(metadata, { ...exercise, name: "Primo" }, day, { ...exercise, name: "Secondo" }));
  assert.deepEqual(parsed.sessions[0].exercises.map((item) => item.name), ["Primo", "Secondo"]);
});

test("invalid CSV structure is explicit and never silently drops data", () => {
  const valid = csv(metadata, day, exercise);
  const invalid = [
    ["", /Intestazioni/],
    [valid.replace("row_type", "unknown"), /Intestazioni/],
    [valid + '\n"unclosed', /virgolette non chiuse/],
    [valid + '\n"closed"x', /virgolette non valide/],
    [valid + "\nwrong,width", /colonne/],
    [csv(day, exercise), /manca la riga plan/],
    [csv(metadata, metadata, day, exercise), /una sola riga plan/],
    [csv({ ...metadata, format_version: 3 }, day, exercise), /format_version/],
    [csv(metadata, day, day, exercise), /day_key/],
    [csv(metadata, { ...day, day_key: " " }, exercise), /day_key/],
    [csv(metadata, day, { ...exercise, day_key: "missing" }), /non corrisponde/],
    [csv(metadata, day, { ...exercise, row_type: "__proto__" }), /row_type/],
    [csv(metadata, day, { ...exercise, row_type: "constructor" }), /row_type/],
    [csv(metadata, { ...day, target: "ignored?" }, exercise), /target: non applicabile/],
    [csv(metadata, { ...day, duration_minutes: 20 }, exercise), /solo per AMRAP/],
    [csv(metadata, day, { ...exercise, uses_weight: "yes" }), /uses_weight/],
  ];
  for (const [source, message] of invalid) assert.throws(() => parseWorkoutCsv(source), message);
});

test("numeric cells require explicit integers and shared bounds, with standard rest required", () => {
  for (const value of ["", "-1", "1.5", "3601", "60 secondi", "60-90", " 60 ", "01", "1e2"]) {
    assert.throws(() => parseWorkoutCsv(csv(metadata, day, { ...exercise, rest_seconds: value })), /rest_seconds|recupero/);
  }
  for (const [field, bad, good] of [
    ["sets", [0, 31], [1, 30]], ["optional_sets", [-1, 31], [0, 30]], ["rest_seconds", [-1, 3601], [0, 3600]],
  ]) {
    for (const value of bad) assert.throws(() => parseWorkoutCsv(csv(metadata, day, { ...exercise, [field]: value })));
    for (const value of good) assert.deepEqual(validateWorkoutPlan(parseWorkoutCsv(csv(metadata, day, { ...exercise, [field]: value }))), []);
  }
  assert.throws(() => parseWorkoutCsv(csv(metadata, day, { ...exercise, measurement_mode: "guess" })), /tracciamento/);
  assert.throws(() => parseWorkoutCsv(csv({ ...metadata, name: " " }, day, exercise)), /Titolo/);
});

test("AMRAP requires bounded duration, accepts optional rest, rejects ignored per-set fields", () => {
  const circuit = { ...day, session_type: "amrap", duration_minutes: 20 };
  const movement = { row_type: "exercise", day_key: "A", name: "Piegamenti", target: "10" };
  for (const duration of [1, 180]) assert.equal(parseWorkoutCsv(csv(metadata, { ...circuit, duration_minutes: duration }, movement)).sessions[0].type, "amrap");
  for (const duration of ["", 0, 181, "20 minuti", "1.5"]) assert.throws(() => parseWorkoutCsv(csv(metadata, { ...circuit, duration_minutes: duration }, movement)), /durata|duration_minutes/);
  for (const [key, value] of [["sets", 3], ["optional_sets", 0], ["measurement_mode", "reps"], ["uses_weight", "false"]]) {
    assert.throws(() => parseWorkoutCsv(csv(metadata, circuit, { ...movement, [key]: value })), /AMRAP/);
  }
  assert.equal(parseWorkoutCsv(csv(metadata, circuit, { ...movement, rest_seconds: 0 })).sessions[0].exercises[0].rest, 0);
});

test("collection, text, step and size limits are enforced at their exact boundaries", () => {
  for (const [count, valid] of [[0, false], [1, true], [30, true], [31, false]]) {
    const plan = base();
    plan.sessions = Array.from({ length: count }, (_, index) => ({ ...base().sessions[0], id: `day-${index}`, exercises: [{ ...base().sessions[0].exercises[0], id: `exercise-${index}` }] }));
    if (valid) assert.ok(parseWorkoutCsv(exportWorkoutCsv(plan)));
    else assert.throws(() => parseWorkoutCsv(exportWorkoutCsv(plan)), /Giornate/);
  }
  for (const [count, valid] of [[0, false], [1, true], [50, true], [51, false]]) {
    const plan = base();
    plan.sessions[0].exercises = Array.from({ length: count }, (_, index) => ({ ...base().sessions[0].exercises[0], id: `exercise-${index}` }));
    if (valid) assert.ok(parseWorkoutCsv(exportWorkoutCsv(plan)));
    else assert.throws(() => parseWorkoutCsv(exportWorkoutCsv(plan)), /esercizi/);
  }
  for (const count of [0, 50, 51]) {
    const plan = base();
    plan.warmup = Array.from({ length: count }, () => ({ name: "Mobilità", target: "5" }));
    if (count <= 50) assert.ok(parseWorkoutCsv(exportWorkoutCsv(plan)));
    else assert.throws(() => parseWorkoutCsv(exportWorkoutCsv(plan)), /Riscaldamento/);
  }
  const plan = base();
  plan.sessions[0].exercises = Array.from({ length: 25 }, (_, index) => ({ ...base().sessions[0].exercises[0], id: `exercise-${index}`, sets: 30, optionalSets: 30 }));
  assert.ok(parseWorkoutCsv(exportWorkoutCsv(plan)));
  plan.warmup.push({ name: "Warmup", target: "5" });
  assert.throws(() => parseWorkoutCsv(exportWorkoutCsv(plan)), /1500 step/);
  assert.ok(parseWorkoutCsv(csv({ ...metadata, name: "x".repeat(4000) }, day, exercise)));
  assert.throws(() => parseWorkoutCsv(csv({ ...metadata, name: "x".repeat(4001) }, day, exercise)), /4000/);
  assert.throws(() => parseWorkoutCsv("x".repeat(800001)), /troppo grande/);
  assert.throws(() => parseWorkoutCsv("è".repeat(400001)), /troppo grande/);
  assert.throws(() => parseWorkoutCsv(csv(metadata, day, exercise) + "\n".repeat(1601)), /troppe righe/);
  const large = base();
  large.sessions[0].exercises = Array.from({ length: 50 }, (_, index) => ({ ...base().sessions[0].exercises[0], id: `exercise-${index}`, instructions: "x".repeat(4000) }));
  assert.throws(() => parseWorkoutCsv(exportWorkoutCsv(large)), /200000/);
});

test("matching edit exports preserve IDs and legacy or explicit namespaces; new imports reset identity", () => {
  for (const trackingId of [undefined, "lineage-a"]) {
    const original = base();
    if (trackingId) original.trackingId = trackingId;
    original.warmup = [{ id: "mobility", name: "Mobilità", target: "5" }];
    const baseRecord = { id: randomUUID(), definition: original };
    const source = exportWorkoutCsv(original, { sourceVersionId: baseRecord.id });
    const edited = readWorkoutCsv(source.replace("8-12", "10-15"), { baseRecord });
    assert.equal(edited.preservesIdentity, true);
    assert.equal(edited.definition.trackingId, trackingId);
    assert.equal(edited.definition.warmup[0].id, "mobility");
    assert.equal(edited.definition.sessions[0].id, "day");
    assert.equal(edited.definition.sessions[0].exercises[0].id, "exercise");
    assert.equal(edited.definition.sessions[0].exercises[0].target, "10-15");
    const fresh = readWorkoutCsv(source);
    assert.equal(fresh.preservesIdentity, false);
    assert.notEqual(fresh.definition.trackingId, trackingId);
    assert.notEqual(fresh.definition.sessions[0].exercises[0].id, "exercise");
  }
});

test("edit round-trips support reordering, removal and blank-ID additions without guessing identity", () => {
  const original = base();
  original.sessions[0].exercises.push({ ...original.sessions[0].exercises[0], id: "second", name: "Press" });
  const baseRecord = { id: randomUUID(), definition: original };
  const exported = exportWorkoutCsv(original, { sourceVersionId: baseRecord.id }).trim().split("\r\n");
  const retained = exported[4];
  const added = retained.replace('"Press"', '"New movement"').replace(/"second"$/, '""');
  const parsed = readWorkoutCsv([...exported.slice(0, 3), retained, added].join("\r\n"), { baseRecord });
  assert.deepEqual(parsed.definition.sessions[0].exercises.map((item) => item.name), ["Press", "New movement"]);
  assert.equal(parsed.definition.sessions[0].exercises[0].id, "second");
  assert.notEqual(parsed.definition.sessions[0].exercises[1].id, "second");
  const reordered = readWorkoutCsv([...exported.slice(0, 3), exported[4], exported[3]].join("\r\n"), { baseRecord });
  assert.deepEqual(reordered.definition.sessions[0].exercises.map((item) => item.id), ["second", "exercise"]);
});

test("identity metadata rejects malformed, duplicate, wrong-kind, unknown and stale IDs", () => {
  const original = base();
  original.trackingId = "lineage";
  const baseRecord = { id: randomUUID(), definition: original };
  const source = exportWorkoutCsv(original, { sourceVersionId: baseRecord.id });
  for (const [candidate, error] of [
    [source.replace(baseRecord.id, randomUUID()), /altra versione/],
    [source.replace(baseRecord.id, "not-a-version"), /source_version_id/],
    [source.replace('"lineage"', '"other"'), /tracking_id diverso/],
    [source.replace(/"exercise"(?=\r?\n|$)/g, '"day"'), /duplicato/],
    [source.replace(/"exercise"(?=\r?\n|$)/g, '"unknown"'), /non appartiene/],
    [source.replace(/"exercise"(?=\r?\n|$)/g, '"__proto__"'), /row_id/],
    [source.replace(/"day"\r\n/, '""\r\n').replace(/"exercise"(?=\r?\n|$)/g, '"day"'), /tipo di riga/],
  ]) assert.throws(() => readWorkoutCsv(candidate, { baseRecord }), error);
});
