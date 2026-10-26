window.workoutLibrary = (() => {
  const state = { userId: null, record: null, availableRecord: null, loading: false, error: "", notice: "", history: [], historyLoading: false, historyError: "", moreHistory: false };
  let template = null;
  let revision = 0;
  let loadRequest = 0;
  let historyRequest = 0;
  let draft = null;

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
    draft = null;
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
      let deletedActive = false;
      if (state.record && (!record || record.revision < state.record.revision)) {
        const activeRecord = state.record;
        const existing = await window.workoutSocial.fetchPersonalPlan(userId, activeRecord.id);
        if (revision !== currentRevision || request !== loadRequest || state.record !== activeRecord) return;
        if (existing) {
          validateRecord(existing, userId);
          throw new Error("Risposta del server precedente alla versione attiva. Riprova l'aggiornamento.");
        }
        deletedActive = true;
      }
      if (!deletedActive && record && state.record && record.id !== state.record.id
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
      if (deletedActive) {
        state.notice = record
          ? "La scheda attiva è stata eliminata dal server. È stata caricata l'ultima scheda disponibile."
          : "La scheda attiva è stata eliminata dal server. Crea o importa una nuova scheda.";
      }
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
    return draft;
  }

  function getLegacyDraft() {
    if (!state.userId) throw new Error("Accedi prima di modificare una scheda.");
    const raw = localStorage.getItem(draftKey(state.userId));
    if (!raw) return null;
    const stored = JSON.parse(raw);
    if (!isObject(stored) || typeof stored.versionId !== "string" || !isObject(stored.definition)
      || !(stored.baseVersionId === null || typeof stored.baseVersionId === "string")) {
      throw new Error("Bozza locale non valida. Esportala prima di rimuoverla.");
    }
    if (stored.restFormat !== "seconds") normalizeStoredWorkoutRest(stored.definition);
    return stored;
  }

  function writeDraft(definition, baseVersionId = state.record?.id || null) {
    if (!state.userId) throw new Error("Accedi prima di modificare una scheda.");
    draft = { versionId: crypto.randomUUID(), baseVersionId, definition, restFormat: "seconds" };
    return draft;
  }

  function discardDraft() {
    draft = null;
  }

  function discardLegacyDraft() {
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
    if (!navigator.onLine) throw new Error("Sei offline. Torna online per salvare; le modifiche restano solo in questa schermata. Non chiuderla.");
    const record = validateRecord(await window.workoutSocial.savePersonalPlan(userId, submitted), userId);
    if (revision !== currentRevision) throw new Error("Account cambiato durante il salvataggio. Verifica il piano accedendo di nuovo all'account originale.");
    loadRequest += 1;
    state.loading = false;
    if (!state.record || record.revision >= state.record.revision) {
      localStorage.setItem(cacheKey(userId), JSON.stringify(record));
    }
    if (getDraft()?.versionId === submitted.versionId) discardDraft();
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

  return { start, snapshot, identityChanged, load, getDraft, writeDraft, discardDraft, getLegacyDraft, discardLegacyDraft, save, loadHistory, useLatest, completionDetails,
    template: () => structuredClone(template) };
})();
