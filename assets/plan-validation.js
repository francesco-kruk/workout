function validateWorkoutPlan(plan) {
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

function normalizeStoredWorkoutRest(plan) {
  let changed = false;
  for (const day of Array.isArray(plan?.sessions) ? plan.sessions : []) {
    if (!Array.isArray(day?.exercises)) continue;
    for (const exercise of day.exercises) {
      if (typeof exercise?.rest !== "string") continue;
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

if (typeof module !== "undefined") module.exports = { validateWorkoutPlan, normalizeStoredWorkoutRest };
