const WORKOUT_CSV_LEGACY_HEADERS = ["row_type", "format_version", "day_key", "name", "session_type", "target", "sets", "optional_sets", "rest_seconds", "measurement_mode", "uses_weight", "duration_minutes", "subtitle", "instructions"];
const WORKOUT_CSV_HEADERS = [...WORKOUT_CSV_LEGACY_HEADERS, "source_version_id", "tracking_id", "row_id"];
const WORKOUT_CSV_V3_HEADERS = [...WORKOUT_CSV_HEADERS, "block_key", "minute_key", "block_type", "rounds", "optional_rounds", "legacy_day_id"];

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
  const headers = rows[0]?.join(",") === WORKOUT_CSV_V3_HEADERS.join(",") ? WORKOUT_CSV_V3_HEADERS
    : rows[0]?.join(",") === WORKOUT_CSV_HEADERS.join(",") ? WORKOUT_CSV_HEADERS
    : rows[0]?.join(",") === WORKOUT_CSV_LEGACY_HEADERS.join(",") ? WORKOUT_CSV_LEGACY_HEADERS : null;
  if (!headers) {
    throw new Error("Intestazioni CSV non valide. Usa il modello scaricabile senza cambiare le colonne.");
  }
  if (headers === WORKOUT_CSV_V3_HEADERS) return readWorkoutBlocksCsv(rows.slice(1), { baseRecord });
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
    if (baseRecord.definition.version !== 2) throw new Error("CSV: usa l'esportazione con blocchi del piano attuale.");
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
    if (preservesIdentity && retainedIds.has(exercise.id)) {
      const originalDay = baseRecord.definition.sessions.find((item) => item.exercises.some((item) => item.id === exercise.id));
      if (originalDay?.id !== day.id || originalDay.type !== day.type) fail("row_id: giornata o formato originale diverso. Lascia vuoto l'ID per spostare l'esercizio.");
    }
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
  if (plan.version === 3) return exportWorkoutBlocksCsv(plan, { sourceVersionId });
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

function readWorkoutBlocksCsv(rows, { baseRecord }) {
  const plan = { version: 3, title: "", warmup: [], sessions: [] };
  const days = new Map(), blocks = new Map(), minutes = new Map(), identities = [], exercises = [];
  const rowIds = new Set();
  const namespace = crypto.randomUUID();
  let counter = 0, planRows = 0, sourceVersionId = "", trackingId = "";
  const fields = {
    plan: ["format_version", "name", "source_version_id", "tracking_id"],
    warmup: ["name", "target", "instructions", "row_id"],
    day: ["day_key", "name", "subtitle", "instructions", "row_id"],
    block: ["day_key", "block_key", "name", "block_type", "rounds", "optional_rounds", "rest_seconds", "duration_minutes", "instructions", "legacy_day_id", "row_id"],
    minute: ["day_key", "block_key", "minute_key", "row_id"],
    exercise: ["day_key", "block_key", "minute_key", "name", "target", "sets", "optional_sets", "rest_seconds", "measurement_mode", "uses_weight", "instructions", "row_id"],
  };
  for (const [index, cells] of rows.entries()) {
    const fail = (message) => { throw new Error(`Riga ${index + 2}: ${message}`); };
    if (cells.length !== WORKOUT_CSV_V3_HEADERS.length) fail("numero di colonne non valido.");
    const data = Object.fromEntries(WORKOUT_CSV_V3_HEADERS.map((key, i) => {
      const value = cells[i];
      return [key, value.startsWith("'") && /^(?:['\t\r\n]|\s*[=+\-@])/.test(value.slice(1)) ? value.slice(1) : value];
    }));
    if (!Object.hasOwn(fields, data.row_type)) fail("row_type deve essere plan, warmup, day, block, minute o exercise.");
    for (const key of WORKOUT_CSV_V3_HEADERS.slice(1)) {
      if (data[key] && !fields[data.row_type].includes(key)) fail(`${key}: non applicabile a ${data.row_type}.`);
    }
    const number = (key, required = false) => {
      if (!data[key] && !required) return undefined;
      if (!/^(0|[1-9]\d*)$/.test(data[key])) fail(`${key}: inserisci un numero intero esplicito.`);
      const limits = {
        sets: [1, 30], optional_sets: [0, 30], rest_seconds: [0, 3600], duration_minutes: [1, 180],
        rounds: [1, data.block_type === "emom" ? 180 : 30], optional_rounds: [0, 30],
      };
      const value = Number(data[key]);
      const [min, max] = limits[key];
      if (!Number.isInteger(value) || value < min || value > max) fail(`${key}: numero intero da ${min} a ${max}.`);
      return value;
    };
    const inapplicable = (keys, context) => {
      for (const key of keys) if (data[key]) fail(`${key}: non applicabile a ${context}.`);
    };
    const identity = (value) => {
      if (data.row_id && (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(data.row_id)
        || ["warmup", "__proto__", "constructor", "prototype"].includes(data.row_id) || rowIds.has(data.row_id))) {
        fail("row_id non valido o duplicato. Lascia vuoto l'ID per una nuova riga.");
      }
      if (data.row_id) rowIds.add(data.row_id);
      const entry = { value: { id: `csv-${namespace}-${++counter}`, ...value }, data, fail };
      identities.push(entry);
      return entry;
    };
    const requiredKey = (key, map) => {
      if (!data[key].trim() || map?.has(data[key])) fail(`${key} obbligatorio e univoco.`);
    };
    if (data.row_type === "plan") {
      if (++planRows !== 1) fail("una sola riga plan consentita.");
      if (data.format_version !== "3") fail("format_version deve essere 3.");
      plan.title = data.name;
      sourceVersionId = data.source_version_id;
      trackingId = data.tracking_id;
      if (sourceVersionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceVersionId)) fail("source_version_id non valido.");
      if (trackingId && !/^[a-zA-Z0-9_-]{1,80}$/.test(trackingId)) fail("tracking_id non valido.");
    } else if (data.row_type === "warmup") {
      plan.warmup.push(identity({ name: data.name, target: data.target, ...(data.instructions ? { instructions: data.instructions } : {}) }).value);
    } else if (data.row_type === "day") {
      requiredKey("day_key", days);
      const entry = identity({ label: data.name, ...(data.subtitle ? { subtitle: data.subtitle } : {}), ...(data.instructions ? { instructions: data.instructions } : {}), blocks: [] });
      days.set(data.day_key, entry);
      plan.sessions.push(entry.value);
    } else if (data.row_type === "block") {
      requiredKey("day_key");
      requiredKey("block_key", blocks);
      if (!["standard", "superset", "amrap", "emom"].includes(data.block_type)) fail("block_type deve essere standard, superset, amrap o emom.");
      const block = { label: data.name, type: data.block_type, ...(data.instructions ? { instructions: data.instructions } : {}) };
      if (block.type === "superset" || block.type === "emom") block.rounds = number("rounds", true);
      else inapplicable(["rounds"], block.type);
      if (block.type === "superset") {
        block.restSeconds = number("rest_seconds", true);
        if (data.optional_rounds) block.optionalRounds = number("optional_rounds");
      } else inapplicable(["rest_seconds", "optional_rounds"], block.type);
      if (block.type === "amrap") block.durationMinutes = number("duration_minutes", true);
      else inapplicable(["duration_minutes", "legacy_day_id"], block.type);
      if (block.type === "emom") block.minutes = [];
      else block.exercises = [];
      blocks.set(data.block_key, identity(block));
    } else if (data.row_type === "minute") {
      requiredKey("day_key");
      requiredKey("block_key");
      requiredKey("minute_key", minutes);
      minutes.set(data.minute_key, identity({ exercises: [] }));
    } else {
      requiredKey("day_key");
      requiredKey("block_key");
      const exercise = { name: data.name, target: data.target, ...(data.instructions ? { instructions: data.instructions } : {}) };
      for (const [key, field] of [["sets", "sets"], ["optional_sets", "optionalSets"], ["rest_seconds", "rest"]]) {
        if (data[key]) exercise[field] = number(key);
      }
      if (data.measurement_mode) exercise.measurementMode = data.measurement_mode;
      if (data.uses_weight) {
        if (!["true", "false"].includes(data.uses_weight)) fail("uses_weight: usa true o false.");
        exercise.usesWeight = data.uses_weight === "true";
      }
      exercises.push(identity(exercise));
    }
  }
  if (!planRows) throw new Error("CSV: manca la riga plan.");
  for (const entry of blocks.values()) {
    const day = days.get(entry.data.day_key);
    if (!day) entry.fail(`day_key "${entry.data.day_key}" non corrisponde a una giornata.`);
    day.value.blocks.push(entry.value);
  }
  for (const entry of minutes.values()) {
    const block = blocks.get(entry.data.block_key);
    if (!block) entry.fail(`block_key "${entry.data.block_key}" non corrisponde a un blocco.`);
    if (block.data.day_key !== entry.data.day_key) entry.fail("day_key diverso dalla giornata del blocco.");
    if (block.value.type !== "emom") entry.fail("minute: il blocco deve essere EMOM.");
    block.value.minutes.push(entry.value);
  }
  for (const entry of exercises) {
    const { data, value, fail } = entry;
    const block = blocks.get(data.block_key);
    if (!block) fail(`block_key "${data.block_key}" non corrisponde a un blocco.`);
    if (block.data.day_key !== data.day_key) fail("day_key diverso dalla giornata del blocco.");
    if (block.value.type !== "standard" && ["sets", "optional_sets", "rest_seconds"].some((key) => data[key])) {
      fail(`${block.value.type}: serie e rest_seconds non applicabili agli esercizi; nelle superserie il recupero è solo dopo il giro.`);
    }
    if (block.value.type === "standard") {
      if (value.sets === undefined) fail("sets: serie obbligatorie.");
      if (value.rest === undefined) fail("rest_seconds: recupero obbligatorio (0 = nessun recupero).");
    }
    if (block.value.type === "amrap" && (data.measurement_mode || data.uses_weight)) fail("AMRAP: tracciamento individuale non applicabile.");
    if (block.value.type === "emom") {
      const minute = minutes.get(data.minute_key);
      if (!minute || minute.data.block_key !== data.block_key || minute.data.day_key !== data.day_key) fail("minute_key non corrisponde a un minuto del blocco EMOM.");
      minute.value.exercises.push(value);
    } else {
      if (data.minute_key) fail("minute_key: applicabile solo agli esercizi EMOM.");
      block.value.exercises.push(value);
    }
  }
  const preservesIdentity = Boolean(baseRecord && sourceVersionId);
  if (preservesIdentity) {
    if (sourceVersionId !== baseRecord.id) throw new Error("CSV di un'altra versione o di un altro piano. Esporta il piano attuale oppure importalo come Nuovo piano.");
    if (trackingId !== (baseRecord.definition.trackingId || "")) throw new Error("tracking_id diverso dal piano originale. Non modificare i metadati dello storico.");
    if (baseRecord.definition.version !== 3) throw new Error("CSV: la versione originale non contiene blocchi. Converti il piano in Manuale e salva esplicitamente.");
    const known = new Map();
    const remember = (value, kind, parent = null, type = null) => known.set(value.id, { kind, parent, type, value });
    for (const item of baseRecord.definition.warmup) remember(item, "warmup");
    for (const day of baseRecord.definition.sessions) {
      remember(day, "day");
      for (const block of day.blocks) {
        remember(block, "block", day.id, block.type);
        if (block.type === "emom") {
          for (const minute of block.minutes) {
            remember(minute, "minute", block.id);
            for (const exercise of minute.exercises) remember(exercise, "exercise", minute.id);
          }
        } else for (const exercise of block.exercises) remember(exercise, "exercise", block.id);
      }
    }
    for (const { value, data, fail } of identities) {
      if (!data.row_id) continue;
      const original = known.get(data.row_id);
      if (!original || original.kind !== data.row_type) fail("row_id non appartiene a questo tipo di riga del piano originale. Lascia vuoto l'ID per una nuova riga.");
      let parent;
      if (data.row_type === "block") parent = days.get(data.day_key);
      if (data.row_type === "minute") parent = blocks.get(data.block_key);
      if (data.row_type === "exercise") parent = data.minute_key ? minutes.get(data.minute_key) : blocks.get(data.block_key);
      if (parent && (original.parent !== parent.data.row_id
        || (data.row_type === "block" && original.type !== value.type))) {
        fail("row_id: associazione o formato originale diverso. Lascia vuoto l'ID dell'elemento e dei suoi figli per spostarlo.");
      }
      value.id = data.row_id;
    }
    if (baseRecord.definition.trackingId !== undefined) plan.trackingId = baseRecord.definition.trackingId;
    for (const entry of blocks.values()) {
      if (!entry.data.legacy_day_id) continue;
      const original = known.get(entry.data.row_id);
      if (original?.value.legacyDayId !== entry.data.legacy_day_id) entry.fail("legacy_day_id non appartiene al blocco AMRAP originale.");
    }
  } else plan.trackingId = crypto.randomUUID();
  for (const entry of blocks.values()) {
    if (!entry.data.legacy_day_id) continue;
    const day = days.get(entry.data.day_key);
    if (entry.data.legacy_day_id !== day.data.row_id) entry.fail("legacy_day_id deve corrispondere al row_id della giornata.");
    entry.value.legacyDayId = day.value.id;
  }
  const validate = typeof validateWorkoutPlan === "function" ? validateWorkoutPlan : require("./plan-validation.js").validateWorkoutPlan;
  const errors = validate(plan);
  if (errors.length) throw new Error(errors.join("\n"));
  return { definition: plan, preservesIdentity };
}

function exportWorkoutBlocksCsv(plan, { sourceVersionId }) {
  const rows = [];
  const add = (values) => rows.push(WORKOUT_CSV_V3_HEADERS.map((key) => values[key] ?? ""));
  add({ row_type: "plan", format_version: 3, name: plan.title, source_version_id: sourceVersionId, tracking_id: plan.trackingId });
  for (const item of plan.warmup) add({ row_type: "warmup", row_id: item.id, name: item.name, target: item.target, instructions: item.instructions });
  plan.sessions.forEach((day, dayIndex) => {
    const dayKey = `day-${dayIndex + 1}`;
    add({ row_type: "day", day_key: dayKey, row_id: day.id, name: day.label, subtitle: day.subtitle, instructions: day.instructions });
    day.blocks.forEach((block, blockIndex) => {
      const blockKey = `${dayKey}-block-${blockIndex + 1}`;
      add({ row_type: "block", day_key: dayKey, block_key: blockKey, row_id: block.id, name: block.label, block_type: block.type,
        instructions: block.instructions, rounds: block.rounds, optional_rounds: block.optionalRounds, rest_seconds: block.restSeconds,
        duration_minutes: block.durationMinutes, legacy_day_id: block.legacyDayId });
      const groups = block.type === "emom" ? block.minutes : [{ exercises: block.exercises }];
      groups.forEach((minute, minuteIndex) => {
        const minuteKey = block.type === "emom" ? `${blockKey}-minute-${minuteIndex + 1}` : "";
        if (minuteKey) add({ row_type: "minute", day_key: dayKey, block_key: blockKey, minute_key: minuteKey, row_id: minute.id });
        for (const item of minute.exercises) add({ row_type: "exercise", day_key: dayKey, block_key: blockKey, minute_key: minuteKey, row_id: item.id,
          name: item.name, target: item.target, instructions: item.instructions, sets: item.sets, optional_sets: item.optionalSets,
          rest_seconds: item.rest, measurement_mode: item.measurementMode, uses_weight: item.usesWeight });
      });
    });
  });
  const encode = (value) => {
    let text = String(value);
    if (/^(?:['\t\r\n]|\s*[=+\-@])/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + [WORKOUT_CSV_V3_HEADERS.join(","), ...rows.map((row) => row.map(encode).join(","))].join("\r\n") + "\r\n";
}

if (typeof module !== "undefined") module.exports = {
  parseWorkoutCsv, readWorkoutCsv, exportWorkoutCsv, WORKOUT_CSV_HEADERS, WORKOUT_CSV_LEGACY_HEADERS, WORKOUT_CSV_V3_HEADERS,
};
