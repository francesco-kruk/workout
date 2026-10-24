const WORKOUT_CSV_HEADERS = ["row_type", "format_version", "day_key", "name", "session_type", "target", "sets", "optional_sets", "rest_seconds", "measurement_mode", "uses_weight", "duration_minutes", "subtitle", "instructions"];

function parseWorkoutCsv(source) {
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
  if (!rows.length || rows[0].join(",") !== WORKOUT_CSV_HEADERS.join(",")) {
    throw new Error("Intestazioni CSV non valide. Usa il modello scaricabile senza cambiare le colonne.");
  }
  const plan = { version: 2, title: "", warmup: [], sessions: [] };
  const days = new Map(), exercises = [];
  let planRows = 0, counter = 0;
  const namespace = crypto.randomUUID();
  const escapedText = (value) => /^(?:['\t\r\n]|\s*[=+\-@])/.test(value);
  const decode = (value) => value.startsWith("'") && escapedText(value.slice(1)) ? value.slice(1) : value;
  for (const [index, cells] of rows.slice(1).entries()) {
    const fail = (message) => { throw new Error(`Riga ${index + 2}: ${message}`); };
    if (cells.length !== WORKOUT_CSV_HEADERS.length) fail("numero di colonne non valido.");
    const data = Object.fromEntries(WORKOUT_CSV_HEADERS.map((key, i) => [key, decode(cells[i])]));
    const fields = {
      plan: ["format_version", "name"],
      warmup: ["name", "target", "instructions"],
      day: ["day_key", "name", "session_type", "duration_minutes", "subtitle", "instructions"],
      exercise: ["day_key", "name", "target", "sets", "optional_sets", "rest_seconds", "measurement_mode", "uses_weight", "instructions"],
    };
    const allowed = Object.hasOwn(fields, data.row_type) ? fields[data.row_type] : null;
    if (!allowed) fail("row_type deve essere plan, warmup, day o exercise.");
    for (const key of WORKOUT_CSV_HEADERS.slice(1)) {
      if (data[key] && !allowed.includes(key)) fail(`${key}: non applicabile a ${data.row_type}.`);
    }
    const number = (key, required = false) => {
      if (!data[key] && !required) return undefined;
      if (!/^(0|[1-9]\d*)$/.test(data[key])) fail(`${key}: inserisci un numero intero esplicito.`);
      return Number(data[key]);
    };
    const item = () => ({ id: `csv-${namespace}-${++counter}`, name: data.name, target: data.target, instructions: data.instructions });
    if (data.row_type === "plan") {
      if (++planRows > 1) fail("una sola riga plan consentita.");
      if (data.format_version !== "1") fail("format_version deve essere 1.");
      plan.title = data.name;
    } else if (data.row_type === "warmup") plan.warmup.push(item());
    else if (data.row_type === "day") {
      if (!data.day_key.trim() || days.has(data.day_key)) fail("day_key obbligatorio e univoco.");
      const day = { id: `csv-${namespace}-${++counter}`, label: data.name, type: data.session_type, subtitle: data.subtitle, instructions: data.instructions, exercises: [] };
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
  return plan;
}

function exportWorkoutCsv(plan) {
  const rows = [];
  const add = (values) => rows.push(WORKOUT_CSV_HEADERS.map((key) => values[key] ?? ""));
  add({ row_type: "plan", format_version: 1, name: plan.title });
  for (const item of plan.warmup) add({ row_type: "warmup", name: item.name, target: item.target, instructions: item.instructions });
  plan.sessions.forEach((day, index) => {
    const key = `day-${index + 1}`;
    add({ row_type: "day", day_key: key, name: day.label, session_type: day.type, duration_minutes: day.type === "amrap" ? String(day.duration ?? "").replace(/ (?:min|minuti)$/, "") : "", subtitle: day.subtitle, instructions: day.instructions });
    for (const item of day.exercises) {
      add({ row_type: "exercise", day_key: key, name: item.name, target: item.target, instructions: item.instructions,
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

if (typeof module !== "undefined") module.exports = { parseWorkoutCsv, exportWorkoutCsv, WORKOUT_CSV_HEADERS };
