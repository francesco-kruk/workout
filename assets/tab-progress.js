function renderProgress(container) {
  container.replaceChildren(
    textEl("p", "La tua costanza", "cycle-label"),
    textEl("h2", "Progressi")
  );
  const personal = document.createElement("section");
  personal.className = "social-panel personal-progress";
  const monthly = document.createElement("section");
  monthly.className = "social-panel";
  const history = document.createElement("section");
  history.className = "social-panel workout-history";
  const ranking = document.createElement("section");
  container.append(personal, monthly, ranking, history);

  function update() {
    const library = window.workoutLibrary.snapshot();
    const social = window.workoutSocial.snapshot();
    personal.replaceChildren(textEl("h3", "Allenamento attuale"));
    const session = library.plan?.sessions.find((day) => day.id === getCurrentSessionId(library.plan));
    if (session) {
      personal.appendChild(textEl("p", session.label, "view-description"));
      personal.appendChild(createProgress(getSessionSummary(library.plan, session)));
      personal.appendChild(textEl("p", "Progressi su questo dispositivo, per il piano attivo. Non sono un totale degli allenamenti svolti.", "view-description"));
    } else {
      personal.appendChild(textEl("p", "Crea un piano nella tab Piano per iniziare.", "view-description"));
    }

    monthly.replaceChildren(textEl("h3", "Riepilogo mensile"));
    const own = social.rows.find((row) => row.user_id === social.user?.id);
    if (own) {
      if (own.month_start) {
        monthly.appendChild(textEl("p", new Intl.DateTimeFormat("it-IT", {
          month: "long", year: "numeric", timeZone: "Europe/Rome",
        }).format(new Date(`${own.month_start}T12:00:00Z`)), "cycle-label"));
      }
      const metrics = document.createElement("dl");
      metrics.className = "progress-metrics";
      for (const [label, value] of [
        ["Giorni di allenamento", own.gym_days],
        ["Punti", formatScore(own.points)],
        ["Sequenza attiva", `${own.current_streak} allenamenti`],
        ["Moltiplicatore", `${formatScore(own.multiplier)}×`],
      ]) {
        const metric = document.createElement("div");
        metric.append(textEl("dt", label), textEl("dd", String(value)));
        metrics.appendChild(metric);
      }
      monthly.appendChild(metrics);
      monthly.appendChild(textEl("p", "Dati sincronizzati · giorni e punti del mese; la sequenza può continuare tra mesi.", "view-description"));
      if (social.updatedAt) monthly.appendChild(textEl("p", `Ultimo aggiornamento: ${new Date(social.updatedAt).toLocaleString("it-IT")}.`, "view-description"));
    } else {
      monthly.appendChild(textEl("p", !social.configured
        ? "Le statistiche mensili richiedono l'accesso al gruppo."
        : "Statistiche mensili non ancora disponibili. Consulta lo stato della classifica qui sotto.", "view-description"));
    }
    const status = textEl("p", library.error, "social-status");
    status.setAttribute("role", "status");
    status.classList.toggle("error", Boolean(library.error));
    monthly.appendChild(status);
    renderWorkoutHistory(history, library);
  }

  const events = ["workout-history-change", "workout-library-status", "workout-social-change"];
  for (const event of events) window.addEventListener(event, update);
  update();
  const cleanupRanking = renderLeaderboard(ranking, { embedded: true });
  void window.workoutLibrary.loadHistory();
  return () => {
    for (const event of events) window.removeEventListener(event, update);
    cleanupRanking();
  };
}

function renderWorkoutHistory(container, state) {
  container.replaceChildren(
    textEl("h3", "Storico privato"),
    textEl("p", "Solo tu puoi leggere questi dettagli: attività completate o saltate e giri AMRAP, non pesi o ripetizioni effettive.", "view-description")
  );
  if (!state.userId) {
    container.appendChild(textEl("p", "Lo storico sincronizzato richiede un piano personale e l'accesso al gruppo.", "view-description"));
    return;
  }
  try {
    const pending = pendingAttendance(state.userId).filter((receipt) => receipt.workout);
    if (pending.length) container.appendChild(textEl("p", `${pending.length} allenamenti locali in attesa di invio. Non ancora inclusi nello storico sincronizzato o nei punti.`, "view-description"));
  } catch (error) {
    console.error("Lettura allenamenti in attesa non riuscita.", error);
    const status = textEl("p", error.message, "social-status error");
    status.setAttribute("role", "alert");
    container.appendChild(status);
  }
  if (state.historyError) {
    const error = textEl("p", state.historyError, "social-status error");
    error.setAttribute("role", "status");
    container.appendChild(error);
  }
  if (state.historyLoading) container.appendChild(textEl("p", "Caricamento storico...", "view-description"));
  if (!state.history.length && !state.historyLoading && !state.historyError) container.appendChild(textEl("p", "Nessun allenamento sincronizzato.", "view-description"));
  for (const result of state.history) {
    const details = document.createElement("details");
    const date = new Date(result.completed_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" });
    details.appendChild(textEl("summary", `${date} · ${result.session.label} · ${result.plan_title} (v${result.revision})`));
    const original = document.createElement("details");
    original.appendChild(textEl("summary", "Piano di questo allenamento"));
    for (const item of result.warmup) original.appendChild(createReadonlyItem(item.name, item.target, item.instructions));
    original.appendChild(renderPlanSession(result.session, 0, 1));
    details.appendChild(original);
    const list = document.createElement("ul");
    const historicalPlan = { warmup: result.warmup, sessions: [result.session] };
    for (const step of getWorkoutSteps(historicalPlan, result.session)) {
      const label = step.type === "warmup" ? step.item.name
        : step.type === "amrap" ? `AMRAP: ${result.amrap_rounds} giri`
          : `${step.exercise.name}, serie ${step.setNumber} · ${step.exercise.target}`;
      list.appendChild(textEl("li", `${label}: ${result.steps[step.key] === "completed" ? "Fatto" : "Saltato"}`));
    }
    details.appendChild(list);
    container.appendChild(details);
  }
  const actions = document.createElement("div");
  actions.className = "editor-actions";
  if (state.moreHistory) {
    const more = createButton("Carica precedenti", "btn btn-secondary");
    more.disabled = state.historyLoading;
    more.addEventListener("click", () => { void window.workoutLibrary.loadHistory(true); });
    actions.appendChild(more);
  }
  const refresh = createButton("Aggiorna storico", "btn btn-secondary");
  refresh.disabled = state.historyLoading;
  refresh.addEventListener("click", () => { void window.workoutLibrary.loadHistory(); });
  actions.appendChild(refresh);
  container.appendChild(actions);
}
