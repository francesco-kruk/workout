const STORAGE_KEYS = {
  currentSessionId: "workout.currentSessionId",
  progress: "workout.progress",
  activeView: "workout.activeView",
};

const PROGRESS_VERSION = 2;
const VALID_VIEWS = new Set(["plan", "day", "workout"]);

function getCurrentSessionId(plan) {
  const stored = localStorage.getItem(STORAGE_KEYS.currentSessionId);
  if (stored && plan.sessions.some((session) => session.id === stored)) {
    return stored;
  }
  return plan.sessions[0]?.id || null;
}

function setCurrentSessionId(sessionId) {
  localStorage.setItem(STORAGE_KEYS.currentSessionId, sessionId);
}

function getActiveView() {
  const stored = localStorage.getItem(STORAGE_KEYS.activeView);
  return VALID_VIEWS.has(stored) ? stored : "workout";
}

function setActiveView(view) {
  if (VALID_VIEWS.has(view)) {
    localStorage.setItem(STORAGE_KEYS.activeView, view);
  }
}

function readProgressStore() {
  const emptyStore = { version: PROGRESS_VERSION, sessions: {} };
  const raw = localStorage.getItem(STORAGE_KEYS.progress);
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
  localStorage.setItem(STORAGE_KEYS.progress, JSON.stringify(store));
}

function getProgress(sessionId) {
  const stored = readProgressStore().sessions[sessionId];
  return {
    sessionId,
    steps: isObject(stored?.steps) ? { ...stored.steps } : {},
    history: Array.isArray(stored?.history) ? [...stored.history] : [],
    amrap: normalizeAmrap(stored?.amrap),
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

function clearProgress(sessionId) {
  const store = readProgressStore();
  store.sessions[sessionId] = {
    steps: {},
    history: [],
    amrap: normalizeAmrap(),
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

function getStoredSession(store, sessionId) {
  const stored = store.sessions[sessionId];
  return {
    steps: isObject(stored?.steps) ? { ...stored.steps } : {},
    history: Array.isArray(stored?.history) ? [...stored.history] : [],
    amrap: normalizeAmrap(stored?.amrap),
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
    completed: Boolean(amrap?.completed),
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
