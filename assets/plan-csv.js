const WORKOUT_CSV_LEGACY_HEADERS = ["row_type", "format_version", "day_key", "name", "session_type", "target", "sets", "optional_sets", "rest_seconds", "measurement_mode", "uses_weight", "duration_minutes", "subtitle", "instructions"];
const WORKOUT_CSV_HEADERS = [...WORKOUT_CSV_LEGACY_HEADERS, "source_version_id", "tracking_id", "row_id"];

function readWorkoutCsv(source, { baseRecord = null } = {}) {
  if (typeof source !== "string" || source.length > 800000 || new Blob([source]).size > 800000) throw new Error("CSV troppo grande (massimo 800000 byte).");
  source = source.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes(";") ? ";" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false, closed = false;
  for (let i = 0; i <= source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === undefined) throw new Error(`Riga ${rows.length + 1}: virgolette non chiuse.`);
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !cell && !closed) { quoted = true; continue; }
    if (ch === delimiter || ch === "\n" || ch === "\r" || ch === undefined) {
      row.push(cell); cell = ""; closed = false;
      if (ch !== delimiter) {
        rows.push(row); row = [];
        if (rows.length > 1600) throw new Error("CSV: troppe righe (massimo 1600).");
        if (ch === "\r" && source[i + 1] === "\n") i++;
      }
    } else {
      if (closed || ch === '"') throw new Error(`Riga ${rows.length + 1}: virgolette non valide.`);
      cell += ch;
    }
  }
  while (rows.length && rows.at(-1).every((value) => !value)) rows.pop();
  const headers = rows[0]?.join(",") === WORKOUT_CSV_HEADERS.join(",") ? WORKOUT_CSV_HEADERS
    : rows[0]?.join(",") === WORKOUT_CSV_LEGACY_HEADERS.join(",") ? WORKOUT_CSV_LEGACY_HEADERS : null;
  if (!headers) {
    throw new Error("Intestazioni CSV non valide. Usa il modello scaricabile senza cambiare le colonne.");
  }
  const plan = { version: 2, title: "", warmup: [], sessions: [] };
  const days = new Map(), exercises = [];
  let planRows = 0, counter = 0;
  const namespace = crypto.randomUUID();
  const retainedIds = new Set();
  const identities = [];
  let sourceVersionId = "", trackingId = "";
  const escapedText = (value) => /^(?:['\t\r\n]|\s*[=+\-@])/.test(value);
  const decode = (value) => value.startsWith("'") && escapedText(value.slice(1)) ? value.slice(1) : value;
  for (const [index, cells] of rows.slice(1).entries()) {
    const fail = (message) => { throw new Error(`Riga ${index + 2}: ${message}`); };
    if (cells.length !== headers.length) fail("numero di colonne non valido.");
    const data = Object.fromEntries(headers.map((key, i) => [key, decode(cells[i])]));
    const fields = {
      plan: ["format_version", "name", "source_version_id", "tracking_id"],
      warmup: ["name", "target", "instructions", "row_id"],
      day: ["day_key", "name", "session_type", "duration_minutes", "subtitle", "instructions", "row_id"],
      exercise: ["day_key", "name", "target", "sets", "optional_sets", "rest_seconds", "measurement_mode", "uses_weight", "instructions", "row_id"],
    };
    const allowed = Object.hasOwn(fields, data.row_type) ? fields[data.row_type] : null;
    if (!allowed) fail("row_type deve essere plan, warmup, day o exercise.");
    for (const key of headers.slice(1)) {
      if (data[key] && !allowed.includes(key)) fail(`${key}: non applicabile a ${data.row_type}.`);
    }
    const number = (key, required = false) => {
      if (!data[key] && !required) return undefined;
      if (!/^(0|[1-9]\d*)$/.test(data[key])) fail(`${key}: inserisci un numero intero esplicito.`);
      return Number(data[key]);
    };
    const identity = () => {
      if (data.row_id) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(data.row_id)
          || ["warmup", "__proto__", "constructor", "prototype"].includes(data.row_id) || retainedIds.has(data.row_id)) {
          fail("row_id non valido o duplicato. Lascia vuoto l'ID per una nuova riga.");
        }
        retainedIds.add(data.row_id);
      }
      const value = { id: `csv-${namespace}-${++counter}` };
      identities.push({ value, id: data.row_id, kind: data.row_type, fail });
      return value;
    };
    const item = () => Object.assign(identity(), { name: data.name, target: data.target, instructions: data.instructions });
    if (data.row_type === "plan") {
      if (++planRows > 1) fail("una sola riga plan consentita.");
      if (data.format_version !== (headers === WORKOUT_CSV_HEADERS ? "2" : "1")) fail(`format_version deve essere ${headers === WORKOUT_CSV_HEADERS ? 2 : 1}.`);
      plan.title = data.name;
      sourceVersionId = data.source_version_id || "";
      trackingId = data.tracking_id || "";
      if (sourceVersionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceVersionId)) fail("source_version_id non valido.");
      if (trackingId && !/^[a-zA-Z0-9_-]{1,80}$/.test(trackingId)) fail("tracking_id non valido.");
    } else if (data.row_type === "warmup") plan.warmup.push(item());
    else if (data.row_type === "day") {
      if (!data.day_key.trim() || days.has(data.day_key)) fail("day_key obbligatorio e univoco.");
      const day = Object.assign(identity(), { label: data.name, type: data.session_type, subtitle: data.subtitle, instructions: data.instructions, exercises: [] });
      if (data.duration_minutes) {
        if (day.type !== "amrap") fail("duration_minutes solo per AMRAP.");
        day.duration = `${number("duration_minutes", true)} minuti`;
      }
      days.set(data.day_key, day);
      plan.sessions.push(day);
    } else {
      const exercise = item();
      for (const [key, field] of [["sets", "sets"], ["optional_sets", "optionalSets"], ["rest_seconds", "rest"]]) {
        const value = number(key);
        if (value !== undefined) exercise[field] = value;
      }
      if (data.measurement_mode) exercise.measurementMode = data.measurement_mode;
      if (data.uses_weight) {
        if (!["true", "false"].includes(data.uses_weight)) fail("uses_weight: usa true o false.");
        exercise.usesWeight = data.uses_weight === "true";
      }
      exercises.push({ key: data.day_key, exercise, fail });
    }
  }
  if (!planRows) throw new Error("CSV: manca la riga plan.");
  const preservesIdentity = Boolean(baseRecord && sourceVersionId);
  if (preservesIdentity) {
    if (sourceVersionId !== baseRecord.id) throw new Error("CSV di un'altra versione o di un altro piano. Esporta il piano attuale oppure importalo come Nuovo piano.");
    if (trackingId !== (baseRecord.definition.trackingId || "")) throw new Error("tracking_id diverso dal piano originale. Non modificare i metadati dello storico.");
    const known = new Map();
    for (const item of baseRecord.definition.warmup) known.set(item.id, "warmup");
    for (const day of baseRecord.definition.sessions) {
      known.set(day.id, "day");
      for (const item of day.exercises) known.set(item.id, "exercise");
    }
    for (const entry of identities) {
      if (!entry.id) continue;
      if (known.get(entry.id) !== entry.kind) entry.fail("row_id non appartiene a questo tipo di riga del piano originale. Lascia vuoto l'ID per una nuova riga.");
      entry.value.id = entry.id;
    }
    if (baseRecord.definition.trackingId !== undefined) plan.trackingId = baseRecord.definition.trackingId;
  } else plan.trackingId = crypto.randomUUID();
  for (const { key, exercise, fail } of exercises) {
    const day = days.get(key);
    if (!day) fail(`day_key "${key}" non corrisponde a una giornata.`);
    if (day.type === "amrap" && (exercise.sets !== undefined || exercise.optionalSets !== undefined || exercise.measurementMode !== undefined || exercise.usesWeight !== undefined)) {
      fail("AMRAP: lascia vuoti serie e impostazioni di tracciamento individuali.");
    }
    day.exercises.push(exercise);
  }
  const validate = typeof validateWorkoutPlan === "function" ? validateWorkoutPlan : require("./plan-validation.js").validateWorkoutPlan;
  const errors = validate(plan);
  if (errors.length) throw new Error(errors.join("\n"));
  return { definition: plan, preservesIdentity };
}

function parseWorkoutCsv(source, options) {
  return readWorkoutCsv(source, options).definition;
}

function exportWorkoutCsv(plan, { sourceVersionId = null } = {}) {
  const rows = [];
  const add = (values) => rows.push(WORKOUT_CSV_HEADERS.map((key) => values[key] ?? ""));
  add({ row_type: "plan", format_version: 2, name: plan.title, source_version_id: sourceVersionId, tracking_id: plan.trackingId });
  for (const item of plan.warmup) add({ row_type: "warmup", row_id: item.id, name: item.name, target: item.target, instructions: item.instructions });
  plan.sessions.forEach((day, index) => {
    const key = `day-${index + 1}`;
    add({ row_type: "day", row_id: day.id, day_key: key, name: day.label, session_type: day.type, duration_minutes: day.type === "amrap" ? String(day.duration ?? "").replace(/ (?:min|minuti)$/, "") : "", subtitle: day.subtitle, instructions: day.instructions });
    for (const item of day.exercises) {
      add({ row_type: "exercise", row_id: item.id, day_key: key, name: item.name, target: item.target, instructions: item.instructions,
        rest_seconds: item.rest, ...(day.type === "standard" ? { sets: item.sets, optional_sets: item.optionalSets, measurement_mode: item.measurementMode || "reps", uses_weight: item.usesWeight ?? false } : {}) });
    }
  });
  const encode = (value) => {
    let text = String(value);
    if (/^(?:['\t\r\n]|\s*[=+\-@])/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + [WORKOUT_CSV_HEADERS.join(","), ...rows.map((row) => row.map(encode).join(","))].join("\r\n") + "\r\n";
}

if (typeof module !== "undefined") module.exports = { parseWorkoutCsv, readWorkoutCsv, exportWorkoutCsv, WORKOUT_CSV_HEADERS, WORKOUT_CSV_LEGACY_HEADERS };
