function validateWorkoutPlan(plan) {
  if (plan?.version === 3) return validateBlockWorkoutPlan(plan);
  const errors = [];
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const text = (value, path, empty = false) => {
    if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 4000) {
      errors.push(`${path}: testo ${empty ? "" : "obbligatorio, "}massimo 4000 caratteri.`);
    }
  };
  const ids = new Set();
  const id = (value, path) => {
    if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value)
      || ["warmup", "__proto__", "constructor", "prototype"].includes(value) || ids.has(value)) {
      errors.push(`${path}: ID non valido o duplicato.`);
    }
    ids.add(value);
  };
  const array = (value, path, max, min = 1) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
      errors.push(`${path}: inserisci da ${min} a ${max} elementi.`);
      return [];
    }
    return value;
  };
  if (!object(plan)) return ["La scheda deve essere un oggetto JSON."];
  if (JSON.stringify(plan).length > 200000) errors.push("Scheda troppo grande (massimo 200000 caratteri).");
  if (plan.version !== 2) errors.push("version deve essere 2.");
  if (plan.trackingId !== undefined
    && (typeof plan.trackingId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(plan.trackingId))) {
    errors.push("trackingId: identificatore dello storico non valido.");
  }
  text(plan.title, "Titolo");
  for (const [index, item] of array(plan.warmup, "Riscaldamento", 50, 0).entries()) {
    const path = `Riscaldamento ${index + 1}`;
    if (!object(item)) { errors.push(`${path}: elemento non valido.`); continue; }
    id(item.id, path);
    text(item.name, `${path}, nome`);
    text(item.target, `${path}, obiettivo`);
    if (item.instructions !== undefined) text(item.instructions, `${path}, istruzioni`, true);
  }
  for (const [index, session] of array(plan.sessions, "Giornate", 30).entries()) {
    const path = `Giornata ${index + 1}`;
    if (!object(session)) { errors.push(`${path}: elemento non valido.`); continue; }
    id(session.id, path);
    text(session.label, `${path}, nome`);
    if (session.subtitle !== undefined) text(session.subtitle, `${path}, sottotitolo`, true);
    if (session.instructions !== undefined) text(session.instructions, `${path}, istruzioni`, true);
    if (!["standard", "amrap"].includes(session.type)) errors.push(`${path}: tipo non valido.`);
    if (session.type === "amrap"
      && (typeof session.duration !== "string" || !/^[1-9]\d{0,2}(?: (?:min|minuti))?$/.test(session.duration)
        || parseInt(session.duration, 10) > 180)) {
      errors.push(`${path}: durata AMRAP da 1 a 180 minuti (es. "20 minuti").`);
    }
    let steps = Array.isArray(plan.warmup) ? plan.warmup.length : 0;
    for (const [exerciseIndex, exercise] of array(session.exercises, `${path}, esercizi`, 50).entries()) {
      const exercisePath = `${path}, esercizio ${exerciseIndex + 1}`;
      if (!object(exercise)) { errors.push(`${exercisePath}: elemento non valido.`); continue; }
      id(exercise.id, exercisePath);
      text(exercise.name, `${exercisePath}, nome`);
      text(exercise.target, `${exercisePath}, obiettivo`);
      if (exercise.instructions !== undefined) text(exercise.instructions, `${exercisePath}, istruzioni`, true);
      if (exercise.measurementMode !== undefined && !["reps", "seconds"].includes(exercise.measurementMode)) {
        errors.push(`${exercisePath}: tracciamento in ripetizioni o secondi.`);
      }
      if (exercise.usesWeight !== undefined && typeof exercise.usesWeight !== "boolean") {
        errors.push(`${exercisePath}: uso del peso deve essere vero o falso.`);
      }
      if (session.type === "standard" || exercise.rest !== undefined) {
        if (!Number.isInteger(exercise.rest) || exercise.rest < 0 || exercise.rest > 3600) {
          errors.push(`${exercisePath}: recupero obbligatorio, numero intero da 0 a 3600 secondi (0 = nessun recupero).`);
        }
      }
      if (session.type === "standard") {
        if (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 30) {
          errors.push(`${exercisePath}: serie obbligatorie da 1 a 30.`);
        }
        if (exercise.optionalSets !== undefined
          && (!Number.isInteger(exercise.optionalSets) || exercise.optionalSets < 0 || exercise.optionalSets > 30)) {
          errors.push(`${exercisePath}: serie opzionali da 0 a 30.`);
        }
        steps += exercise.sets + (exercise.optionalSets || 0);
      }
    }
    if (steps > 1500) errors.push(`${path}: massimo 1500 step.`);
  }
  return errors;
}

function getSessionBlocks(session) {
  if (Array.isArray(session.blocks)) return session.blocks;
  return [{
    id: session.id, label: session.subtitle || session.label, type: session.type,
    instructions: session.instructions || "", exercises: session.exercises,
    ...(session.type === "amrap" ? { durationMinutes: parseInt(session.duration, 10) } : {}),
    legacy: true,
  }];
}

function getBlockExercises(block) {
  return block.type === "emom" ? block.minutes.flatMap((minute) => minute.exercises) : block.exercises;
}

function upgradeWorkoutPlan(plan) {
  const upgraded = structuredClone(plan);
  if (upgraded.version === 3) return upgraded;
  upgraded.version = 3;
  for (const day of upgraded.sessions) {
    const block = getSessionBlocks(day)[0];
    delete block.legacy;
    block.id = `block-${crypto.randomUUID()}`;
    if (block.type === "amrap") {
      block.legacyDayId = day.id;
      for (const exercise of block.exercises) {
        for (const key of ["sets", "optionalSets", "rest", "measurementMode", "usesWeight"]) delete exercise[key];
      }
    }
    day.blocks = [block];
    delete day.type;
    delete day.duration;
    delete day.exercises;
  }
  return upgraded;
}

function workoutBlockLabel(block) {
  return { standard: "Serie", superset: "Superserie", amrap: "AMRAP", emom: "EMOM" }[block.type];
}

function workoutJsonbSize(value) {
  // PostgreSQL includes a space after each object colon and collection comma.
  if (Array.isArray(value)) return 2 + value.reduce((size, item) => size + workoutJsonbSize(item), 0) + Math.max(0, value.length - 1) * 2;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return 2 + entries.reduce((size, [key, item]) => size + JSON.stringify(key).length + 2 + workoutJsonbSize(item), 0)
      + Math.max(0, entries.length - 1) * 2;
  }
  return JSON.stringify(value).length;
}

function validateBlockWorkoutPlan(plan) {
  const errors = [];
  const ids = new Set();
  const allowed = (value, keys, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: elemento non valido.`);
      return false;
    }
    for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${path}: ${key} non applicabile.`);
    return true;
  };
  const identity = (item, path) => {
    const id = item?.id;
    if (typeof id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(id)
      || ["warmup", "__proto__", "constructor", "prototype"].includes(id) || ids.has(id)) {
      errors.push(`${path}: ID non valido o duplicato.`);
    }
    ids.add(id);
  };
  const integer = (value, min, max, path) => {
    if (!Number.isInteger(value) || value < min || value > max) errors.push(`${path}: numero intero da ${min} a ${max}.`);
  };
  if (JSON.stringify(plan).length > 200000) errors.push("Scheda troppo grande (massimo 200000 caratteri).");
  allowed(plan, ["version", "title", "trackingId", "warmup", "sessions"], "Piano");
  for (const item of Array.isArray(plan.warmup) ? plan.warmup : []) {
    allowed(item, ["id", "name", "target", "instructions"], "Riscaldamento");
    identity(item, "Riscaldamento");
  }
  const projected = { ...plan, version: 2, sessions: [] };
  for (const [dayIndex, day] of (Array.isArray(plan.sessions) ? plan.sessions : []).entries()) {
    const path = `Giornata ${dayIndex + 1}`;
    if (!allowed(day, ["id", "label", "subtitle", "instructions", "blocks"], path)) continue;
    identity(day, path);
    if (!Array.isArray(day.blocks) || day.blocks.length < 1 || day.blocks.length > 50) {
      errors.push(`${path}: da 1 a 50 blocchi.`);
      continue;
    }
    const flat = { id: day.id, label: day.label, subtitle: day.subtitle, instructions: day.instructions, type: "standard", exercises: [] };
    let work = Array.isArray(plan.warmup) ? plan.warmup.length : 0;
    let legacyAmrap = 0;
    for (const block of day.blocks) {
      const at = `${path}, blocco`;
      if (!allowed(block, ["id", "label", "instructions", "type",
        ...({ standard: ["exercises"], superset: ["exercises", "rounds", "optionalRounds", "restSeconds"],
          amrap: ["exercises", "durationMinutes", "legacyDayId"], emom: ["rounds", "minutes"] }[block?.type] || [])], at)) continue;
      identity(block, at);
      if (typeof block.label !== "string" || !block.label.trim() || block.label.length > 4000) errors.push(`${at}: nome obbligatorio, massimo 4000 caratteri.`);
      if (block.instructions !== undefined && (typeof block.instructions !== "string" || block.instructions.length > 4000)) errors.push(`${at}: istruzioni non valide.`);
      if (!["standard", "superset", "amrap", "emom"].includes(block.type)) { errors.push(`${at}: tipo non valido.`); continue; }
      if (block.type === "superset") {
        integer(block.rounds, 1, 30, `${at}, giri`);
        if (block.optionalRounds !== undefined) integer(block.optionalRounds, 0, 30, `${at}, giri opzionali`);
        integer(block.restSeconds, 0, 3600, `${at}, recupero`);
      }
      if (block.type === "amrap") {
        integer(block.durationMinutes, 1, 180, `${at}, durata AMRAP`);
        if (block.legacyDayId !== undefined && (block.legacyDayId !== day.id || ++legacyAmrap > 1)) errors.push(`${at}: identità AMRAP precedente non valida.`);
      }
      const groups = block.type === "emom" ? block.minutes : [{ exercises: block.exercises }];
      if (!Array.isArray(groups) || !groups.length || groups.length > 50) { errors.push(`${at}: da 1 a 50 minuti.`); continue; }
      if (block.type === "emom") {
        integer(block.rounds, 1, 180, `${at}, giri EMOM`);
        integer(block.rounds * groups.length, 1, 180, `${at}, durata EMOM`);
      }
      for (const group of groups) {
        if (block.type === "emom") {
          if (!allowed(group, ["id", "exercises"], `${at}, minuto`)) continue;
          identity(group, `${at}, minuto`);
        }
        if (!Array.isArray(group.exercises) || group.exercises.length < (block.type === "superset" ? 2 : 1) || group.exercises.length > 50) {
          errors.push(`${at}: numero di esercizi non valido (superserie: almeno 2).`);
          continue;
        }
        for (const exercise of group.exercises) {
          if (!allowed(exercise, ["id", "name", "target", "instructions",
            ...(block.type !== "amrap" ? ["measurementMode", "usesWeight"] : []),
            ...(block.type === "standard" ? ["sets", "optionalSets", "rest"] : [])], at)) continue;
          identity(exercise, `${at}, esercizio`);
          const sets = block.type === "standard" ? exercise.sets : block.type === "superset" ? block.rounds : 1;
          const optionalSets = block.type === "superset" ? block.optionalRounds || 0 : block.type === "standard" ? exercise.optionalSets || 0 : 0;
          flat.exercises.push({ ...exercise, sets, optionalSets, rest: block.type === "standard" ? exercise.rest : 0 });
          work += block.type === "emom" ? block.rounds : sets + optionalSets;
        }
      }
    }
    if (work > 1500) errors.push(`${path}: massimo 1500 step espansi.`);
    projected.sessions.push(flat);
  }
  errors.push(...validateWorkoutPlan(projected));
  return [...new Set(errors)];
}

function normalizeStoredWorkoutRest(plan) {
  let changed = false;
  for (const day of Array.isArray(plan?.sessions) ? plan.sessions : []) {
    if (!Array.isArray(day?.exercises)) continue;
    for (const exercise of day.exercises) {
      if (typeof exercise?.rest !== "string") continue;
      if (day.type === "standard" && !exercise.rest.trim()) {
        exercise.rest = 0;
        changed = true;
        continue;
      }
      if (day.type === "amrap" && !exercise.rest.trim()) {
        delete exercise.rest;
        changed = true;
        continue;
      }
      const match = exercise.rest.trim().match(/^(\d{1,4})(?:-(\d{1,4}))?(?: (?:s|sec|secondi))?$/);
      if (!match) continue;
      const lower = Number(match[1]);
      const upper = Number(match[2] ?? match[1]);
      if (upper > 3600 || lower > upper) continue;
      exercise.rest = upper;
      changed = true;
    }
  }
  return changed;
}

if (typeof module !== "undefined") module.exports = {
  validateWorkoutPlan, normalizeStoredWorkoutRest, getSessionBlocks, getBlockExercises,
  upgradeWorkoutPlan, workoutBlockLabel,
  workoutJsonbSize,
};
