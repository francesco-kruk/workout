// localStorage-backed app state. No plan data or progress ever leaves the browser
// except through the explicit GitHub write path in github.js.
const STORAGE_KEYS = {
  currentDayId: "workout.currentDayId",
  progress: "workout.progress",
  token: "workout.token",
};

function getToken() {
  return localStorage.getItem(STORAGE_KEYS.token) || "";
}

function setToken(token) {
  if (token) {
    localStorage.setItem(STORAGE_KEYS.token, token);
  } else {
    localStorage.removeItem(STORAGE_KEYS.token);
  }
}

function getCurrentDayId(plan) {
  const stored = localStorage.getItem(STORAGE_KEYS.currentDayId);
  if (stored && plan.days.some((d) => d.id === stored)) {
    return stored;
  }
  return plan.days[0] ? plan.days[0].id : null;
}

function setCurrentDayId(dayId) {
  localStorage.setItem(STORAGE_KEYS.currentDayId, dayId);
}

function getProgress(dayId) {
  const raw = localStorage.getItem(STORAGE_KEYS.progress);
  if (!raw) return { dayId, checked: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed.dayId !== dayId) return { dayId, checked: {} };
    return parsed;
  } catch {
    return { dayId, checked: {} };
  }
}

function setChecked(dayId, key, value) {
  const progress = getProgress(dayId);
  progress.checked[key] = value;
  localStorage.setItem(STORAGE_KEYS.progress, JSON.stringify(progress));
}

function clearProgress(dayId) {
  localStorage.setItem(STORAGE_KEYS.progress, JSON.stringify({ dayId, checked: {} }));
}

function nextDayId(plan, currentDayId) {
  const idx = plan.days.findIndex((d) => d.id === currentDayId);
  const nextIdx = (idx + 1) % plan.days.length;
  return plan.days[nextIdx].id;
}
