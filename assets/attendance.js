const ATTENDANCE_KEY = "workout.attendance.";

function initializeAttendanceRuns(plan) {
  const store = readProgressStore();
  let changed = false;
  for (const session of plan.sessions) {
    const stored = store.sessions[session.id];
    if (!stored || stored.runId) continue;
    const legacyCompletion = getSessionSummary(plan, session).complete;
    store.sessions[session.id] = {
      ...getStoredSession(store, session.id),
      legacyCompletion,
    };
    changed = true;
  }
  if (changed) writeProgressStore(store);
}

function readAttendance() {
  const receipts = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(ATTENDANCE_KEY)) continue;
    const receipt = JSON.parse(localStorage.getItem(key));
    if (!isObject(receipt) || receipt.version !== 1 || typeof receipt.id !== "string"
      || !["pending", "synced", "uncredited"].includes(receipt.status)
      || !(receipt.userId === null || typeof receipt.userId === "string")
      || !Number.isFinite(Date.parse(receipt.completedAt))) {
      throw new Error("Archivio presenze non valido. Non cancellare i dati prima di recuperarli.");
    }
    receipts[key.slice(ATTENDANCE_KEY.length)] = receipt;
  }
  return { version: 1, receipts };
}

function recordAttendance(runId, userId, completedAt = new Date().toISOString(), workout = null) {
  const store = readAttendance();
  if (store.receipts[runId]) return store.receipts[runId];
  const receipt = {
    version: 1,
    id: crypto.randomUUID(),
    userId,
    completedAt,
    status: userId ? "pending" : "uncredited",
    workout,
  };
  localStorage.setItem(`${ATTENDANCE_KEY}${runId}`, JSON.stringify(receipt));
  return receipt;
}

function pendingAttendance(userId) {
  return Object.values(readAttendance().receipts).filter(
    (receipt) => receipt.userId === userId && receipt.status === "pending"
  );
}

function acknowledgeAttendance(eventId, userId) {
  const store = readAttendance();
  const entry = Object.entries(store.receipts).find(
    ([_runId, item]) => item.id === eventId && item.userId === userId
  );
  if (!entry) throw new Error("Presenza locale non trovata.");
  const [runId, receipt] = entry;
  receipt.status = "synced";
  localStorage.setItem(`${ATTENDANCE_KEY}${runId}`, JSON.stringify(receipt));
}

function applyWorkoutProgress(plan, sessionId, update) {
  const wasComplete = getSessionSummary(
    plan, plan.sessions.find((session) => session.id === sessionId)
  ).complete;
  update();
  const summary = getSessionSummary(
    plan, plan.sessions.find((session) => session.id === sessionId)
  );
  if (!wasComplete && summary.complete && !summary.progress.legacyCompletion) {
    const session = plan.sessions.find((item) => item.id === sessionId);
    window.workoutSocial.recordCompletion(
      summary.progress.runId,
      window.workoutLibrary?.completionDetails(plan, summary, session) || null
    );
  }
}
