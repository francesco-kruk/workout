const STORAGE_KEYS = {
  currentSessionId: "workout.currentSessionId",
  progress: "workout.progress",
  activeView: "workout.activeView",
};

const PROGRESS_VERSION = 2;
const VALID_VIEWS = new Set(["plan", "progress", "workout", "leaderboard", "profile"]);
window.WORKOUT_EXERCISE_SETUP_SECONDS = 5;
let workoutScope = "";

function workoutStorageKey(key) {
  return workoutScope ? `${key}:${workoutScope}` : key;
}

function setWorkoutScope(userId, versionId) {
  workoutScope = userId ? `${userId}:${versionId || "unselected"}` : "";
}

function getCurrentSessionId(plan) {
  const stored = readProgressStore().currentSessionId
    || localStorage.getItem(workoutStorageKey(STORAGE_KEYS.currentSessionId));
  if (stored && plan.sessions.some((session) => session.id === stored)) {
    return stored;
  }
  return plan.sessions[0]?.id || null;
}

function setCurrentSessionId(sessionId) {
  const store = readProgressStore();
  for (const [id, progress] of Object.entries(store.sessions)) {
    if (id !== sessionId) progress.exerciseTimer = null;
  }
  store.currentSessionId = sessionId;
  writeProgressStore(store);
}

function applyManualWorkoutProgress(plan, intent) {
  const store = readProgressStore();
  if (store.manualApplied?.[intent.id]) return;
  if (getCurrentSessionId(plan) !== intent.sessionId || getProgress(intent.sessionId).runId !== intent.runId) {
    throw new Error("Richiesta salvata, ma la giornata è cambiata. Il piano non è stato modificato.");
  }
  const current = getStoredSession(store, intent.sessionId);
  if (current.amrap.deadline !== null) {
    current.amrap.remainingMilliseconds = Math.max(0, current.amrap.deadline - Date.now());
    current.amrap.deadline = null;
  }
  for (const block of Object.values(current.blocks)) {
    if (block.timer?.deadline != null) {
      block.timer = { ...block.timer, remainingMilliseconds: Math.max(0, block.timer.deadline - Date.now()), deadline: null };
    }
  }
  current.restTimer = null;
  current.exerciseTimer = null;
  if (intent.replacesPlanned) {
    const nextId = nextSessionId(plan, intent.sessionId);
    store.sessions[intent.sessionId] = current;
    store.sessions[nextId] = {
      runId: crypto.randomUUID(), steps: {}, history: [], results: {},
      amrap: normalizeAmrap(), restTimer: null,
    };
    store.currentSessionId = nextId;
  } else {
    store.sessions[intent.sessionId] = current;
  }
  store.manualApplied = { ...store.manualApplied, [intent.id]: true };
  // Progression and the retry marker must commit together.
  writeProgressStore(store);
}

function getActiveView() {
  const stored = localStorage.getItem(STORAGE_KEYS.activeView);
  if (stored === "day") {
    setActiveView("plan");
    return "plan";
  }
  return VALID_VIEWS.has(stored) ? stored : "plan";
}

function setActiveView(view) {
  if (VALID_VIEWS.has(view)) {
    localStorage.setItem(STORAGE_KEYS.activeView, view);
  }
}

function readProgressStore() {
  const emptyStore = { version: PROGRESS_VERSION, sessions: {} };
  const raw = localStorage.getItem(workoutStorageKey(STORAGE_KEYS.progress));
  if (!raw) return emptyStore;

  try {
    const parsed = JSON.parse(raw);
    if (parsed.version === PROGRESS_VERSION && isObject(parsed.sessions)) {
      return parsed;
    }

    if (parsed.sessionId && isObject(parsed.checked)) {
      const steps = Object.fromEntries(
        Object.keys(parsed.checked)
          .filter((key) => parsed.checked[key])
          .map((key) => [key, "completed"])
      );
      const migrated = {
        version: PROGRESS_VERSION,
        sessions: {
          [parsed.sessionId]: {
            steps,
            history: Object.keys(steps),
          },
        },
      };
      writeProgressStore(migrated);
      return migrated;
    }
  } catch {
    return emptyStore;
  }

  return emptyStore;
}

function writeProgressStore(store) {
  localStorage.setItem(workoutStorageKey(STORAGE_KEYS.progress), JSON.stringify(store));
}

function getProgress(sessionId) {
  const stored = readProgressStore().sessions[sessionId];
  return {
    sessionId,
    runId: typeof stored?.runId === "string" ? stored.runId : null,
    legacyCompletion: stored?.legacyCompletion === true,
    steps: isObject(stored?.steps) ? { ...stored.steps } : {},
    history: Array.isArray(stored?.history) ? [...stored.history] : [],
    results: isObject(stored?.results) ? { ...stored.results } : {},
    amrap: normalizeAmrap(stored?.amrap),
    blocks: isObject(stored?.blocks) ? JSON.parse(JSON.stringify(stored.blocks)) : {},
    restTimer: normalizeRestTimer(stored?.restTimer),
    exerciseTimer: normalizeExerciseTimer(stored?.exerciseTimer, stored?.runId),
  };
}

function setStepStatus(sessionId, key, status) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);

  progress.steps[key] = status;
  progress.exerciseTimer = null;
  progress.history = progress.history.filter((item) => item !== key);
  progress.history.push(key);
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
}

function completeStepsBefore(plan, sessionId, targetKey) {
  const session = plan.sessions.find((item) => item.id === sessionId);
  if (!session) return false;

  const steps = getWorkoutSteps(plan, session);
  const targetIndex = steps.findIndex((step) => step.key === targetKey);
  if (targetIndex < 0) return false;

  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  const precedingKeys = steps.slice(0, targetIndex).map((step) => step.key);
  if (steps.slice(0, targetIndex).some((step) => ["amrap", "emom"].includes(step.type) && !progress.steps[step.key])) {
    throw new Error("Completa i blocchi a tempo prima di saltare agli esercizi successivi.");
  }
  if (plan.version === 3 && steps.slice(0, targetIndex).some((step) => {
    if (step.type !== "set" || progress.steps[step.key]) return false;
    const value = parseSetResult(progress.results[step.key], step.exercise);
    const { mode, usesWeight } = getExerciseTracking(step.exercise);
    return value[mode] === undefined || (usesWeight && value.weightKg === undefined);
  })) throw new Error("Registra i risultati delle serie precedenti prima di avanzare.");
  const precedingKeySet = new Set(precedingKeys);

  for (const key of precedingKeys) {
    if (plan.version !== 3 || !progress.steps[key]) progress.steps[key] = "completed";
  }
  progress.history = [
    ...progress.history.filter((key) => !precedingKeySet.has(key)),
    ...precedingKeys,
  ];
  progress.restTimer = null;
  progress.exerciseTimer = null;
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
  return true;
}

function undoLastStep(sessionId, plan = null) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  const key = progress.history.pop();
  if (!key) return null;

  const day = plan?.sessions.find((session) => session.id === sessionId);
  const steps = day ? getWorkoutSteps(plan, day) : [];
  const last = steps.find((step) => step.key === key);
  if (last?.block?.type === "superset" && progress.steps[key] === "skipped") {
    const round = steps.filter((step) => step.block?.id === last.block.id && step.setNumber === last.setNumber);
    for (const step of round) {
      delete progress.steps[step.key];
      progress.history = progress.history.filter((entry) => entry !== step.key);
    }
  }
  delete progress.steps[key];
  progress.exerciseTimer = null;
  if (key === `${sessionId}:amrap`) {
    progress.amrap.completed = false;
  }
  progress.restTimer = null;
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
  return key;
}

function updateAmrap(sessionId, updates) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  progress.amrap = {
    ...normalizeAmrap(progress.amrap),
    ...updates,
  };
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
  return { ...progress.amrap };
}

function updateBlockProgress(sessionId, blockId, updates) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  progress.blocks[blockId] = { ...progress.blocks[blockId], ...updates };
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
  return JSON.parse(JSON.stringify(progress.blocks[blockId]));
}

function getBlockProgress(sessionId, block) {
  return getProgress(sessionId).blocks[block.id] || {};
}

function timedBlockMilliseconds(block) {
  return (block.type === "amrap" ? block.durationMinutes : block.rounds * block.minutes.length) * 60000;
}

function timedBlockClock(block, saved = {}) {
  const duration = timedBlockMilliseconds(block);
  const timer = saved.timer;
  if (timer != null && (!isObject(timer) || !Number.isFinite(timer.remainingMilliseconds)
    || timer.remainingMilliseconds < 0 || timer.remainingMilliseconds > duration
    || !(timer.deadline === null || Number.isFinite(timer.deadline)))) throw new Error("Timer del blocco non valido.");
  const remaining = timer?.deadline != null ? Math.max(0, timer.deadline - Date.now())
    : timer?.remainingMilliseconds ?? duration;
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > duration
    || (timer?.deadline != null && !Number.isFinite(timer.deadline))) throw new Error("Timer del blocco non valido.");
  const elapsed = duration - remaining;
  return {
    remaining, elapsed, running: timer?.deadline != null && remaining > 0,
    minute: Math.min(Math.floor(elapsed / 60000), duration / 60000 - 1),
  };
}

function blockCompletionResults(session, progress) {
  const results = {};
  for (const block of session.blocks) {
    if (!["amrap", "emom"].includes(block.type)) continue;
    const value = progress.blocks[block.id] || {};
    if (timedBlockClock(block, value).remaining !== 0) throw new Error("Il timer del blocco deve terminare.");
    if (block.type === "amrap") {
      results[block.id] = { rounds: parseAmrapCount(value.rounds ?? 0, "Giri completi"),
        extraReps: parseAmrapCount(value.extraReps, "Ripetizioni extra", true) };
    } else {
      const minutes = {};
      const count = block.rounds * block.minutes.length;
      if (!isObject(value.minutes) || Object.keys(value.minutes).length !== count) {
        throw new Error("EMOM: conferma esattamente tutti i minuti del programma.");
      }
      for (let index = 0; index < count; index++) {
        const minute = value.minutes?.[index];
        if (!minute || !["completed", "missed"].includes(minute.status)) throw new Error(`EMOM: conferma il minuto ${index + 1}.`);
        const measurements = {};
        for (const exercise of block.minutes[index % block.minutes.length].exercises) {
          const raw = minute.measurements?.[exercise.id];
          if (!raw) continue;
          let parsed;
          try { parsed = parseSetResult(raw, exercise); }
          catch (failure) { throw new Error(`Minuto ${index + 1}, ${exercise.name}: ${failure.message}`); }
          if (minute.status === "missed" && Object.keys(parsed).length) throw new Error("Un minuto mancato non può contenere misurazioni.");
          if (Object.keys(parsed).length) measurements[exercise.id] = parsed;
        }
        minutes[index] = { status: minute.status, measurements };
      }
      results[block.id] = { minutes };
    }
  }
  if (workoutJsonbSize(results) > 200000) throw new Error("Risultati dei blocchi troppo grandi (massimo 200000 caratteri).");
  return results;
}

function updateSetResult(sessionId, key, values) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  progress.results[key] = { ...values };
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
}

function getExerciseTracking(exercise) {
  return {
    mode: exercise.measurementMode ?? "reps",
    usesWeight: exercise.usesWeight ?? false,
  };
}

function formatExerciseTracking(exercise) {
  const { mode, usesWeight } = getExerciseTracking(exercise);
  return `Tracciamento: ${mode === "seconds" ? "durata in secondi" : "ripetizioni"}${usesWeight ? " e peso (kg)" : ""}`;
}

function parseSetResult(input = {}, exercise = null) {
  const result = {};
  if (input.notes !== undefined) {
    if (typeof input.notes !== "string" || input.notes.length > 1000) {
      throw new Error("Note: inserisci un testo di massimo 1000 caratteri.");
    }
    if (input.notes.trim()) result.notes = input.notes;
  }
  const { mode, usesWeight } = exercise ? getExerciseTracking(exercise) : { mode: input.mode, usesWeight: true };
  for (const key of [...(usesWeight ? ["weightKg"] : []), mode === "seconds" ? "seconds" : "reps"]) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    const max = key === "weightKg" ? 2000 : key === "seconds" ? 86400 : 100000;
    if (!Number.isFinite(value) || value < 0 || value > max
      || (key === "weightKg" ? Math.abs(value * 100 - Math.round(value * 100)) > 0.000001 : !Number.isInteger(value))) {
      throw new Error(key === "weightKg"
        ? "Peso: inserisci da 0 a 2000 kg, con al massimo due decimali."
        : `Inserisci un numero intero da 0 a ${max} ${key === "seconds" ? "secondi" : "ripetizioni"}.`);
    }
    result[key] = value;
  }
  return result;
}

function formatActualResult(result) {
  if (!result || !["weightKg", "reps", "seconds", "notes"].some((key) => result[key] !== undefined)) return "Non registrato";
  return [
    result.weightKg !== undefined ? `${Number(result.weightKg).toLocaleString("it-IT")} kg` : "",
    result.reps !== undefined ? `${result.reps} ripetizioni` : "",
    result.seconds !== undefined ? `${result.seconds} secondi` : "",
    result.notes ? `Note: ${result.notes}` : "",
  ].filter(Boolean).join(" · ");
}

function formatAmrapResult(rounds, extraReps) {
  return `${rounds} giri${extraReps === "" || extraReps == null ? "" : ` + ${extraReps} ripetizioni extra`}`;
}

function parseAmrapCount(raw, label, optional = false) {
  if (optional && (raw === "" || raw === undefined || raw === null)) return null;
  const value = Number(raw);
  if (!["number", "string"].includes(typeof raw) || (typeof raw === "string" && !raw.trim())
    || !Number.isInteger(value) || value < 0 || value > 100000) {
    throw new Error(`${label}: inserisci un numero intero da 0 a 100000.`);
  }
  return value;
}

function updateRestTimer(sessionId, timer) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  progress.restTimer = normalizeRestTimer(timer);
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
  return normalizeRestTimer(progress.restTimer);
}

function clearRestTimer(sessionId) {
  updateRestTimer(sessionId, null);
}

function updateExerciseTimer(sessionId, timer) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  const normalized = timer === null ? null : normalizeExerciseTimer({ ...timer, runId: progress.runId }, progress.runId);
  if (timer !== null && !normalized) throw new Error("Timer esercizio non valido.");
  progress.exerciseTimer = normalized;
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
  return normalized;
}

function parseExerciseTargetSeconds(target) {
  const match = String(target).trim().match(/^(\d+)(?:\s*[-\u2013]\s*(\d+))?\s*(s|sec|secondi?|seconds?|min|minuti?|minutes?)(?:\s+di lavoro)?$/i);
  if (!match) return null;
  const lower = Number(match[1]);
  const upper = Number(match[2] ?? match[1]);
  const seconds = upper * (/^min/i.test(match[3]) ? 60 : 1);
  return lower > 0 && upper >= lower && Number.isInteger(seconds) && seconds <= 86400 ? seconds : null;
}

function normalizeExerciseTimer(timer, runId) {
  const phase = timer?.phase ?? "exercise";
  if (!isObject(timer) || typeof timer.stepKey !== "string" || !timer.stepKey
    || typeof runId !== "string" || timer.runId !== runId
    || !Number.isInteger(timer.durationSeconds) || timer.durationSeconds < 1 || timer.durationSeconds > 86400
    || !Number.isFinite(timer.remainingMilliseconds) || timer.remainingMilliseconds < 0
    || !["setup", "exercise"].includes(phase)
    || timer.remainingMilliseconds > (phase === "setup" ? window.WORKOUT_EXERCISE_SETUP_SECONDS : timer.durationSeconds) * 1000
    || (timer.deadline !== null && !Number.isFinite(timer.deadline))) return null;
  return { ...normalizeRestTimer(timer), stepKey: timer.stepKey, runId, phase };
}

function clearProgress(sessionId) {
  const store = readProgressStore();
  store.sessions[sessionId] = {
    runId: crypto.randomUUID(),
    steps: {},
    history: [],
    results: {},
    amrap: normalizeAmrap(),
    restTimer: null,
  };
  writeProgressStore(store);
}

function nextSessionId(plan, currentSessionId) {
  const index = plan.sessions.findIndex((session) => session.id === currentSessionId);
  if (index < 0 || plan.sessions.length === 0) return null;
  return plan.sessions[(index + 1) % plan.sessions.length].id;
}

function getWorkoutSteps(plan, session) {
  const warmupSteps = plan.warmup.map((item, index) => ({
    key: getWarmupKey(item),
    type: "warmup",
    item,
    position: index + 1,
    total: plan.warmup.length,
    optional: false,
  }));

  if (session.blocks) {
    return [...warmupSteps, ...session.blocks.flatMap((block) => {
      if (["amrap", "emom"].includes(block.type)) return [{
        key: `${block.id}:${block.type}`, type: block.type, block, session, optional: false,
      }];
      const rounds = block.rounds + (block.optionalRounds || 0);
      if (block.type === "superset") return Array.from({ length: rounds }, (_, round) =>
        block.exercises.map((exercise, exerciseIndex) => ({
          key: `${exercise.id}:${round}`, type: "set", exercise, exerciseIndex, block,
          setNumber: round + 1, totalSets: rounds, optional: round >= block.rounds,
          roundEnd: exerciseIndex === block.exercises.length - 1,
        }))
      ).flat();
      return block.exercises.flatMap((exercise, exerciseIndex) =>
        Array.from({ length: exercise.sets + (exercise.optionalSets || 0) }, (_, index) => ({
          key: `${exercise.id}:${index}`, type: "set", exercise, exerciseIndex, block,
          setNumber: index + 1, totalSets: exercise.sets + (exercise.optionalSets || 0), optional: index >= exercise.sets,
        }))
      );
    })];
  }
  if (session.type === "amrap") {
    return [
      ...warmupSteps,
      {
        key: `${session.id}:amrap`,
        type: "amrap",
        session,
        optional: false,
      },
    ];
  }

  const exerciseSteps = session.exercises.flatMap((exercise, exerciseIndex) => {
    const totalSets = exercise.sets + (exercise.optionalSets || 0);
    return Array.from({ length: totalSets }, (_, setIndex) => ({
      key: `${exercise.id}:${setIndex}`,
      type: "set",
      exercise,
      exerciseIndex,
      setNumber: setIndex + 1,
      totalSets,
      optional: setIndex >= exercise.sets,
    }));
  });

  return [...warmupSteps, ...exerciseSteps];
}

function getSessionSummary(plan, session) {
  const progress = getProgress(session.id);
  const steps = getWorkoutSteps(plan, session);
  const required = steps.filter((step) => !step.optional);
  const completedRequired = required.filter(
    (step) => progress.steps[step.key] === "completed"
  ).length;
  const handled = steps.filter((step) => Boolean(progress.steps[step.key])).length;

  return {
    progress,
    steps,
    required,
    completedRequired,
    handled,
    percentage:
      required.length === 0
        ? 100
        : Math.round((completedRequired / required.length) * 100),
    complete:
      completedRequired === required.length && handled === steps.length,
    currentIndex: steps.findIndex((step) => !progress.steps[step.key]),
  };
}

function hasPlannedWorkoutActivity(plan, session) {
  const progress = getProgress(session.id);
  const steps = getWorkoutSteps(plan, session);
  const entered = (value) => value !== undefined && value !== null && String(value).trim() !== "";
  if (steps.some((step) => progress.steps[step.key] === "completed")) return true;
  if (steps.some((step) => {
    if (step.type !== "set") return false;
    const result = progress.results[step.key] || {};
    const { mode, usesWeight } = getExerciseTracking(step.exercise);
    return entered(result[mode]) || (usesWeight && entered(result.weightKg)) || entered(result.notes);
  })) return true;
  if (progress.restTimer || (progress.exerciseTimer
    && steps.some((step) => step.key === progress.exerciseTimer.stepKey))) return true;
  if (Object.values(progress.blocks).some((block) => block.timer || block.rounds > 0
    || entered(block.extraReps) || Object.keys(block.minutes || {}).length)) return true;
  if (session.type !== "amrap") return false;
  const amrap = progress.amrap;
  return amrap.completed || amrap.rounds > 0 || entered(amrap.extraReps)
    || amrap.remainingMilliseconds !== null;
}

function getWarmupKey(item) {
  return `warmup:${item.id}`;
}

function parseDurationSeconds(duration) {
  const match = String(duration).match(/(\d+)/);
  return match ? Number(match[1]) * 60 : 0;
}

function getStoredSession(store, sessionId) {
  const stored = store.sessions[sessionId];
  return {
    runId: typeof stored?.runId === "string" ? stored.runId : crypto.randomUUID(),
    legacyCompletion: stored?.legacyCompletion === true,
    steps: isObject(stored?.steps) ? { ...stored.steps } : {},
    history: Array.isArray(stored?.history) ? [...stored.history] : [],
    results: isObject(stored?.results) ? { ...stored.results } : {},
    amrap: normalizeAmrap(stored?.amrap),
    blocks: isObject(stored?.blocks) ? JSON.parse(JSON.stringify(stored.blocks)) : {},
    restTimer: normalizeRestTimer(stored?.restTimer),
    exerciseTimer: normalizeExerciseTimer(stored?.exerciseTimer, stored?.runId),
  };
}

function normalizeAmrap(amrap) {
  const legacyMilliseconds = Number.isFinite(amrap?.remainingSeconds)
    ? amrap.remainingSeconds * 1000
    : null;
  return {
    remainingMilliseconds: Number.isFinite(amrap?.remainingMilliseconds)
      ? Math.max(0, amrap.remainingMilliseconds)
      : legacyMilliseconds,
    rounds: Number.isFinite(amrap?.rounds) ? Math.max(0, amrap.rounds) : 0,
    extraReps: amrap?.extraReps ?? "",
    completed: Boolean(amrap?.completed),
    deadline: Number.isFinite(amrap?.deadline) ? amrap.deadline : null,
  };
}

function normalizeRestTimer(timer) {
  if (!isObject(timer) || !Number.isFinite(timer.durationSeconds)) return null;

  const deadline = Number.isFinite(timer.deadline) ? timer.deadline : null;
  const remainingMilliseconds = Number.isFinite(timer.remainingMilliseconds)
    ? Math.max(0, timer.remainingMilliseconds)
    : 0;
  return {
    durationSeconds: Math.max(0, timer.durationSeconds),
    deadline,
    remainingMilliseconds:
      deadline === null
        ? remainingMilliseconds
        : Math.max(0, deadline - Date.now()),
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
