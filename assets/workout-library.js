window.workoutLibrary = (() => {
  const state = { userId: null, record: null, availableRecord: null, loading: false, error: "", notice: "", history: [], historyLoading: false, historyError: "", moreHistory: false };
  let template = null;
  let revision = 0;
  let loadRequest = 0;
  let historyRequest = 0;

  const emit = (name = "workout-library-status") => window.dispatchEvent(new Event(name));
  const cacheKey = (userId) => `workout.personalPlan:${userId}`;
  const draftKey = (userId) => `workout.planDraft:${userId}`;
  function report(error, message) {
    console.error(message, error);
    state.error = `${message} ${error.message || String(error)}`;
    emit();
  }

  function validateRecord(record, userId) {
    if (!record || record.user_id !== userId || typeof record.id !== "string"
      || !Number.isInteger(record.revision) || record.revision < 1
      || validateWorkoutPlan(record.definition).length) {
      throw new Error("Scheda personale non valida.");
    }
    return record;
  }

  function activate(record) {
    if (state.record?.id === record?.id) return;
    window.dispatchEvent(new Event("workout-library-will-change"));
    state.record = record;
    state.availableRecord = null;
    state.notice = "";
    setWorkoutScope(state.userId, record?.id);
    if (record) initializeAttendanceRuns(record.definition);
    emit("workout-library-change");
  }

  function identityChanged(userId) {
    if (userId === state.userId) return;
    window.dispatchEvent(new Event("workout-library-will-change"));
    revision += 1;
    state.userId = userId;
    state.record = null;
    state.availableRecord = null;
    state.loading = Boolean(userId);
    state.error = "";
    state.notice = "";
    state.history = [];
    state.historyLoading = false;
    state.historyError = "";
    state.moreHistory = false;
    setWorkoutScope(userId, null);
    emit("workout-library-change");
    emit("workout-history-change");
  }

  function start(defaultPlan) {
    template = defaultPlan;
    identityChanged(window.workoutSocial.snapshot().user?.id || null);
    if (!state.userId && template) initializeAttendanceRuns(template);
  }

  function snapshot() {
    return { ...state, history: [...state.history], plan: state.userId ? state.record?.definition || null : template };
  }

  async function load() {
    const userId = state.userId;
    if (!userId || !window.workoutSocial.snapshot().member) {
      state.loading = false;
      emit();
      return;
    }
    const currentRevision = revision;
    const request = ++loadRequest;
    state.loading = true;
    state.error = "";
    emit();
    try {
      if (!state.record) {
        try {
          const cached = localStorage.getItem(cacheKey(userId));
          if (cached) {
            const record = JSON.parse(cached);
            const changed = normalizeStoredWorkoutRest(record?.definition);
            validateRecord(record, userId);
            if (changed) localStorage.setItem(cacheKey(userId), JSON.stringify(record));
            activate(record);
          }
        } catch (error) {
          report(error, "Cache della scheda non leggibile; tentativo di recupero dal server.");
        }
      }
      if (!navigator.onLine) throw new Error("Sei offline. È disponibile solo la scheda già salvata su questo dispositivo.");
      const record = await window.workoutSocial.fetchPersonalPlan(userId);
      if (revision !== currentRevision || request !== loadRequest) return;
      if (record) validateRecord(record, userId);
      if (record && state.record && record.revision < state.record.revision) {
        throw new Error("Risposta del server precedente alla versione attiva. Riprova l'aggiornamento.");
      }
      if (record && state.record && record.id !== state.record.id
        && state.record.definition.sessions.some((day) => {
          const summary = getSessionSummary(state.record.definition, day);
          return summary.handled > 0 && !summary.complete;
        })) {
        state.availableRecord = record;
        state.notice = "È disponibile un piano aggiornato. Puoi continuare l'allenamento attuale o scegliere il nuovo piano nella tab Piano.";
        return;
      }
      activate(record);
      if (record) localStorage.setItem(cacheKey(userId), JSON.stringify(record));
      else localStorage.removeItem(cacheKey(userId));
    } catch (error) {
      if (revision === currentRevision && request === loadRequest) report(error, "Caricamento scheda personale non riuscito.");
    } finally {
      if (revision === currentRevision && request === loadRequest) {
        state.loading = false;
        emit();
      }
    }
  }

  function getDraft() {
    if (!state.userId) throw new Error("Accedi prima di modificare una scheda.");
    const raw = localStorage.getItem(draftKey(state.userId));
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!isObject(draft) || typeof draft.versionId !== "string" || !isObject(draft.definition)
      || !(draft.baseVersionId === null || typeof draft.baseVersionId === "string")) {
      throw new Error("Bozza locale non valida. Esportala prima di rimuoverla.");
    }
    if (draft.restFormat !== "seconds") {
      normalizeStoredWorkoutRest(draft.definition);
      draft.restFormat = "seconds";
      localStorage.setItem(draftKey(state.userId), JSON.stringify(draft));
    }
    return draft;
  }

  function writeDraft(definition, baseVersionId = state.record?.id || null) {
    if (!state.userId) throw new Error("Accedi prima di modificare una scheda.");
    const draft = { versionId: crypto.randomUUID(), baseVersionId, definition, restFormat: "seconds" };
    localStorage.setItem(draftKey(state.userId), JSON.stringify(draft));
    return draft;
  }

  function discardDraft() {
    if (state.userId) localStorage.removeItem(draftKey(state.userId));
  }

  function useLatest() {
    if (!state.availableRecord) return;
    localStorage.setItem(cacheKey(state.userId), JSON.stringify(state.availableRecord));
    activate(state.availableRecord);
  }

  async function save(draft) {
    const submitted = structuredClone(draft);
    const userId = state.userId;
    const currentRevision = revision;
    const errors = validateWorkoutPlan(submitted.definition);
    if (errors.length) throw new Error(errors.join("\n"));
    if (!userId || !window.workoutSocial.snapshot().member) throw new Error("È richiesto l'accesso al gruppo.");
    if (!navigator.onLine) throw new Error("Bozza conservata sul dispositivo. Torna online per pubblicarla.");
    const record = validateRecord(await window.workoutSocial.savePersonalPlan(userId, submitted), userId);
    if (revision !== currentRevision) throw new Error("Account cambiato durante il salvataggio. La bozza originale è conservata.");
    loadRequest += 1;
    state.loading = false;
    if (!state.record || record.revision >= state.record.revision) {
      localStorage.setItem(cacheKey(userId), JSON.stringify(record));
    }
    if (getDraft()?.versionId === submitted.versionId) localStorage.removeItem(draftKey(userId));
    state.error = "";
    if (!state.record || record.revision >= state.record.revision) activate(record);
    emit();
    return record;
  }

  async function loadHistory(append = false) {
    if (!state.userId || !window.workoutSocial.snapshot().member || state.historyLoading) return;
    const currentRevision = revision;
    const request = ++historyRequest;
    state.historyLoading = true;
    state.historyError = "";
    emit("workout-history-change");
    try {
      const last = append ? state.history.at(-1) : null;
      const rows = await window.workoutSocial.fetchWorkoutHistory(last);
      if (revision !== currentRevision || request !== historyRequest) return;
      state.history = append
        ? [...state.history, ...rows.filter((row) => !state.history.some((existing) => existing.id === row.id))]
        : rows;
      state.moreHistory = rows.length === 20;
    } catch (error) {
      if (revision === currentRevision && request === historyRequest) {
        console.error("Storico non disponibile.", error);
        state.historyError = `Storico non disponibile. ${error.message || String(error)}`;
      }
    } finally {
      if (revision === currentRevision && request === historyRequest) {
        state.historyLoading = false;
        emit("workout-history-change");
      }
    }
  }

  function completionDetails(plan, summary, session) {
    const record = state.record;
    if (!record || record.definition !== plan) return null;
    const measurements = {};
    for (const step of summary.steps) {
      if (step.type !== "set" || summary.progress.steps[step.key] !== "completed") continue;
      const value = parseSetResult(summary.progress.results[step.key], step.exercise);
      if (Object.keys(value).length) measurements[step.key] = value;
    }
    const extraReps = session.type === "amrap"
      ? parseAmrapCount(summary.progress.amrap.extraReps, "Ripetizioni extra", true) : null;
    return {
      planVersionId: record.id,
      sessionId: session.id,
      steps: Object.fromEntries(summary.steps.map((step) => [step.key, summary.progress.steps[step.key]])),
      amrapRounds: session.type === "amrap" ? parseAmrapCount(summary.progress.amrap.rounds, "Giri completi") : null,
      measurements,
      amrapExtraReps: session.type === "amrap" ? extraReps : null,
    };
  }

  return { start, snapshot, identityChanged, load, getDraft, writeDraft, discardDraft, save, loadHistory, useLatest, completionDetails,
    template: () => structuredClone(template) };
})();
