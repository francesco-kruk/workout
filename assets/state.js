const STORAGE_KEYS = {
  currentSessionId: "workout.currentSessionId",
  progress: "workout.progress",
  activeView: "workout.activeView",
};

const PROGRESS_VERSION = 2;
const VALID_VIEWS = new Set(["plan", "workout", "profile"]);
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
  store.currentSessionId = sessionId;
  writeProgressStore(store);
}

function applyManualWorkoutProgress(plan, intent) {
  const store = readProgressStore();
  if (store.manualApplied?.[intent.id]) return;
  if (getCurrentSessionId(plan) !== intent.sessionId || getProgress(intent.sessionId).runId !== intent.runId) {
    throw new Error("Richiesta salvata, ma la giornata è cambiata. Il piano non è stato modificato.");
  }
  if (intent.replacesPlanned) {
    const nextId = nextSessionId(plan, intent.sessionId);
    store.sessions[intent.sessionId] = {
      ...getStoredSession(store, intent.sessionId), restTimer: null,
      amrap: getProgress(intent.sessionId).amrap,
    };
    store.sessions[nextId] = {
      runId: crypto.randomUUID(), steps: {}, history: [], results: {},
      amrap: normalizeAmrap(), restTimer: null,
    };
    store.currentSessionId = nextId;
  } else {
    const progress = getStoredSession(store, intent.sessionId);
    progress.restTimer = null;
    progress.amrap = getProgress(intent.sessionId).amrap;
    store.sessions[intent.sessionId] = progress;
  }
  store.manualApplied = { ...store.manualApplied, [intent.id]: true };
  // Progression and the retry marker must commit together.
  writeProgressStore(store);
}

function getActiveView() {
  const stored = localStorage.getItem(STORAGE_KEYS.activeView);
  if (stored === "day" || stored === "leaderboard" || stored === "progress") {
    const migrated = stored === "day" ? "plan" : "profile";
    setActiveView(migrated);
    return migrated;
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
    restTimer: normalizeRestTimer(stored?.restTimer),
  };
}

function setStepStatus(sessionId, key, status) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);

  progress.steps[key] = status;
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
  const precedingKeySet = new Set(precedingKeys);

  for (const key of precedingKeys) {
    progress.steps[key] = "completed";
  }
  progress.history = [
    ...progress.history.filter((key) => !precedingKeySet.has(key)),
    ...precedingKeys,
  ];
  progress.restTimer = null;
  store.sessions[sessionId] = progress;
  writeProgressStore(store);
  return true;
}

function undoLastStep(sessionId) {
  const store = readProgressStore();
  const progress = getStoredSession(store, sessionId);
  const key = progress.history.pop();
  if (!key) return null;

  delete progress.steps[key];
  if (key === `${sessionId}:amrap`) {
    progress.amrap.completed = false;
  }
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
  if (!result || !["weightKg", "reps", "seconds"].some((key) => result[key] !== undefined)) return "Non registrato";
  return [
    result.weightKg !== undefined ? `${Number(result.weightKg).toLocaleString("it-IT")} kg` : "",
    result.reps !== undefined ? `${result.reps} ripetizioni` : "",
    result.seconds !== undefined ? `${result.seconds} secondi` : "",
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

function getWarmupKey(item) {
  return `warmup:${item.id}`;
}

function parseDurationSeconds(duration) {
  const match = String(duration).match(/(\d+)/);
  return match ? Number(match[1]) * 60 : 0;
}

function parseRestDurationSeconds(duration) {
  const values = String(duration).match(/\d+(?:[.,]\d+)?/g)?.map(Number) || [];
  if (values.length === 0) return 0;
  return Math.round(values.length > 1 ? (values[0] + values[1]) / 2 : values[0]);
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
    restTimer: normalizeRestTimer(stored?.restTimer),
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
