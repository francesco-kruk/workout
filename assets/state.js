const STORAGE_KEYS = {
  currentSessionId: "workout.currentSessionId",
  progress: "workout.progress",
};

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

function getProgress(sessionId) {
  const emptyProgress = { sessionId, checked: {} };
  const raw = localStorage.getItem(STORAGE_KEYS.progress);
  if (!raw) return emptyProgress;

  try {
    const parsed = JSON.parse(raw);
    if (parsed.sessionId !== sessionId || !parsed.checked || typeof parsed.checked !== "object") {
      return emptyProgress;
    }
    return parsed;
  } catch {
    return emptyProgress;
  }
}

function setChecked(sessionId, key, value) {
  const progress = getProgress(sessionId);
  if (value) {
    progress.checked[key] = true;
  } else {
    delete progress.checked[key];
  }
  localStorage.setItem(STORAGE_KEYS.progress, JSON.stringify(progress));
}

function clearProgress(sessionId) {
  localStorage.setItem(
    STORAGE_KEYS.progress,
    JSON.stringify({ sessionId, checked: {} })
  );
}

function nextSessionId(plan, currentSessionId) {
  const index = plan.sessions.findIndex((session) => session.id === currentSessionId);
  if (index < 0 || plan.sessions.length === 0) return null;
  return plan.sessions[(index + 1) % plan.sessions.length].id;
}
