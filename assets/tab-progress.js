function renderProgress(container, { embedded = false } = {}) {
  container.replaceChildren(
    ...(embedded ? [textEl("h3", "Progressi", "profile-progress-heading")] : [
      textEl("p", "La tua costanza", "cycle-label"),
      textEl("h2", "Progressi"),
    ])
  );
  const personal = document.createElement("section");
  personal.className = "social-panel personal-progress";
  const monthly = document.createElement("section");
  monthly.className = "social-panel";
  const history = document.createElement("section");
  history.className = "social-panel workout-history";
  const ranking = document.createElement("section");
  const performance = document.createElement("section");
  performance.className = "social-panel personal-performance";
  const manual = document.createElement("section");
  manual.className = "social-panel";
  container.append(performance, personal, monthly, ranking, manual, history);
  const cleanupPerformance = renderPerformance(performance);
  const cleanupManual = window.renderManualWorkouts?.(manual);

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
      for (const [label, value, unit] of [
        ["Giorni di allenamento", own.gym_days],
        ["Punti Aura", formatScore(own.points)],
        ["Sequenza settimanale", own.weekly_streak || 0, Number(own.weekly_streak) === 1 ? "settimana" : "settimane"],
        ["Moltiplicatore dell'ultima settimana attiva", `${formatScore(own.multiplier)}×`],
      ]) {
        const metric = document.createElement("div");
        const result = textEl("dd", String(value));
        if (unit) result.appendChild(textEl("span", ` ${unit}`, "metric-unit"));
        metric.append(textEl("dt", label), result);
        metrics.appendChild(metric);
      }
      monthly.appendChild(metrics);
      monthly.appendChild(textEl("p", "Dati sincronizzati · giorni e Punti Aura del mese. Il moltiplicatore si applica subito; la sequenza settimanale continua tra mesi.", "view-description"));
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
  const cleanupRanking = renderLeaderboard(ranking, { embedded: true, showProfile: !embedded });
  void window.workoutLibrary.loadHistory();
  return () => {
    for (const event of events) window.removeEventListener(event, update);
    cleanupRanking();
    cleanupPerformance();
    cleanupManual?.();
  };
}

function renderWorkoutHistory(container, state) {
  container.replaceChildren(
    textEl("h3", "Storico privato"),
    textEl("p", "Solo tu puoi leggere questi dettagli: attività, pesi, ripetizioni, durate e risultati AMRAP. I valori non registrati non sono stimati.", "view-description")
  );
  if (!state.userId) {
    container.appendChild(textEl("p", "Lo storico sincronizzato richiede un piano personale e l'accesso al gruppo.", "view-description"));
    return;
  }
  try {
    const pending = pendingAttendance(state.userId).filter((receipt) => receipt.workout);
    if (pending.length) container.appendChild(textEl("p", `${pending.length} allenamenti locali in attesa di invio. Non ancora inclusi nello storico sincronizzato o nei Punti Aura.`, "view-description"));
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
        : step.type === "amrap" ? `AMRAP: ${formatAmrapResult(result.amrap_rounds, result.amrap_extra_reps)}`
          : `${step.exercise.name}, serie ${step.setNumber} · Obiettivo: ${step.exercise.target} · Effettivo: ${formatActualResult(result.measurements?.[step.key])}`;
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

function renderPerformance(container) {
  let active = true;
  let request = 0;
  let owner = window.workoutLibrary.snapshot().userId;
  let selected = null;
  let metric = "max_weight";
  let data = null;
  let loading = false;
  let error = "";
  let updatedAt = null;
  const dateLabel = (date) => new Date(date).toLocaleDateString("it-IT", { timeZone: "Europe/Rome" });
  const amrapLabel = (row) => formatAmrapResult(row.rounds, row.extra_reps) + (row.extra_reps == null ? " · extra non registrate" : "");

  async function load(append = false) {
    const social = window.workoutSocial.snapshot();
    if (!owner || !social.member || social.user?.id !== owner) { render(); return; }
    const id = ++request;
    const user = owner;
    loading = true;
    error = "";
    render();
    try {
      const result = await window.workoutSocial.fetchPerformance(selected, append ? data?.results.at(-1) : null);
      if (!active || id !== request || user !== window.workoutLibrary.snapshot().userId) return;
      data = { ...result, results: append ? [...data.results, ...result.results] : result.results };
      selected = result.results[0]?.series_key || (result.series.some((s) => s.series_key === selected) ? selected : result.series[0]?.series_key) || null;
      updatedAt = new Date();
    } catch (failure) {
      if (!active || id !== request || user !== window.workoutLibrary.snapshot().userId) return;
      console.error("Statistiche personali non disponibili.", failure);
      error = `Statistiche non aggiornate. ${failure.message}`;
    } finally {
      if (active && id === request && user === window.workoutLibrary.snapshot().userId) {
        loading = false;
        render();
      }
    }
  }

  function render() {
    if (!active || !window.document) return;
    container.replaceChildren(textEl("h3", "La tua evoluzione"),
      textEl("p", "Risultati personali, non punti in classifica. Registra peso e ripetizioni o durata durante ogni serie in Allenamento.", "view-description"));
    if (!owner) {
      container.appendChild(textEl("p", "Accedi con un piano personale per registrare e confrontare i tuoi risultati.", "view-description"));
      return;
    }
    const status = textEl("p", error || (loading ? "Caricamento statistiche..." : ""), `social-status${error ? " error" : ""}`);
    status.setAttribute("role", "status");
    container.appendChild(status);
    if (updatedAt) container.appendChild(textEl("p", `Solo risultati sincronizzati · aggiornati ${updatedAt.toLocaleString("it-IT")}${error ? " · dati precedenti" : ""}.`, "view-description"));
    if (data?.series.length) {
      const label = textEl("label", "Esercizio o circuito");
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Esercizio o circuito");
      for (const [index, item] of data.series.entries()) {
        const duplicate = data.series.some((other) => other !== item && other.name === item.name && other.context === item.context);
        const option = textEl("option", `${item.name} · ${item.context} · ${item.workouts} risultati${duplicate ? ` · storico ${index + 1}` : ""}`);
        option.value = item.series_key;
        option.selected = item.series_key === selected;
        select.appendChild(option);
      }
      select.disabled = loading;
      select.addEventListener("change", () => {
        selected = select.value;
        data = { ...data, results: [], more: false };
        void load();
      });
      label.appendChild(select);
      container.appendChild(label);
      const series = data.series.find((item) => item.series_key === selected);
      if (series) renderSeries(series);
    } else if (!loading && !error) {
      container.appendChild(textEl("p", "Nessuna misurazione sincronizzata. I vecchi allenamenti senza valori effettivi non diventano zeri: inizia registrando la prossima serie o un risultato AMRAP.", "view-description"));
    }
    const refresh = createButton(error ? "Riprova statistiche" : "Aggiorna statistiche", "btn btn-secondary");
    refresh.disabled = loading;
    refresh.addEventListener("click", () => { void load(); });
    container.appendChild(refresh);
  }

  function renderSeries(series) {
    const isAmrap = series.kind === "amrap";
    container.appendChild(textEl("p", isAmrap
      ? `Miglior risultato registrato: ${amrapLabel(series.best_amrap)}. Confronto solo a circuito e durata invariati.`
      : `Massimi registrati (indipendenti, non necessariamente nella stessa serie): ${
        [["best_weight", "kg"], ["best_reps", "ripetizioni"], ["best_seconds", "secondi"]]
          .filter(([key]) => series[key] != null).map(([key, unit]) => `${formatScore(series[key])} ${unit}`).join(" · ")
      }. Un peso maggiore con meno ripetizioni non implica un miglioramento assoluto.`, "view-description"));
    const metricOptions = isAmrap ? [["rounds", "Giri completi"], ["extra_reps", "Ripetizioni extra"]]
      : [["max_weight", "Peso massimo (kg)"], ["max_reps", "Ripetizioni massime"], ["max_seconds", "Durata massima (secondi)"]];
    if (!metricOptions.some(([key]) => key === metric)) metric = metricOptions[0][0];
    const metricLabel = textEl("label", "Andamento");
    const metricSelect = document.createElement("select");
    metricSelect.setAttribute("aria-label", "Metrica del grafico");
    for (const [key, name] of metricOptions) {
      const option = textEl("option", name);
      option.value = key;
      option.selected = metric === key;
      metricSelect.appendChild(option);
    }
    metricSelect.addEventListener("change", () => { metric = metricSelect.value; render(); });
    metricLabel.appendChild(metricSelect);
    container.appendChild(metricLabel);
    const rows = data.results;
    const latest = rows[0];
    const previous = rows[1];
    if (latest && previous) {
      container.appendChild(textEl("h4", `Ultima volta vs precedente (${dateLabel(latest.completed_at)} / ${dateLabel(previous.completed_at)})`));
      if (isAmrap) {
        const extraChange = latest.extra_reps != null && previous.extra_reps != null
          ? ` · variazione ripetizioni extra: ${signedDelta(latest.extra_reps, previous.extra_reps)}` : "";
        container.appendChild(textEl("p", `${amrapLabel(latest)} / ${amrapLabel(previous)} · variazione giri: ${signedDelta(latest.rounds, previous.rounds)}${extraChange}.`, "performance-comparison"));
      } else {
        for (const set of latest.sets) {
          const old = previous.sets.find((item) => item.set === set.set);
          const deltas = [["weightKg", "kg"], ["reps", "ripetizioni"], ["seconds", "secondi"]]
            .filter(([key]) => old?.[key] != null && set[key] != null)
            .map(([key, unit]) => `${signedDelta(set[key], old[key])} ${unit}`).join(" · ");
          container.appendChild(textEl("p", `Serie ${set.set}: ${formatActualResult(set)} / ${formatActualResult(old)}${deltas ? ` · variazione: ${deltas}` : ""}`, "performance-comparison"));
        }
      }
    } else if (latest) container.appendChild(textEl("p", "Primo risultato registrato: serve un altro allenamento confrontabile per mostrare una variazione.", "view-description"));
    const points = [...rows].reverse().filter((row) => row[metric] != null);
    if (points.length) {
      const values = points.map((row) => Number(row[metric]));
      const low = Math.min(...values);
      const high = Math.max(...values);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("performance-chart");
      svg.setAttribute("viewBox", "0 0 320 140");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `${metricOptions.find(([key]) => key === metric)[1]}: ${dateLabel(points[0].completed_at)} – ${dateLabel(points.at(-1).completed_at)}. Valori nella tabella seguente.`);
      const line = document.createElementNS(svg.namespaceURI, "polyline");
      line.setAttribute("points", values.map((value, index) => `${20 + index * 280 / Math.max(1, values.length - 1)},${115 - (value - low) * 90 / (high - low || 1)}`).join(" "));
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-width", "2");
      svg.appendChild(line);
      for (const [index, value] of values.entries()) {
        const circle = document.createElementNS(svg.namespaceURI, "circle");
        circle.setAttribute("cx", String(20 + index * 280 / Math.max(1, values.length - 1)));
        circle.setAttribute("cy", String(115 - (value - low) * 90 / (high - low || 1)));
        circle.setAttribute("r", "3");
        circle.setAttribute("fill", "currentColor");
        svg.appendChild(circle);
      }
      container.append(svg, textEl("p", `${dateLabel(points[0].completed_at)} → ${dateLabel(points.at(-1).completed_at)} · da ${formatScore(values[0])} a ${formatScore(values.at(-1))}. ${isAmrap ? "" : "Massimo per allenamento; consulta le singole serie sotto."}`, "view-description"));
    } else if (!loading) container.appendChild(textEl("p", "Questa misura non è stata registrata nei risultati caricati.", "view-description"));
    const table = document.createElement("table");
    table.className = "performance-table";
    table.appendChild(textEl("caption", "Risultati effettivi · più recenti prima"));
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    for (const name of ["Data", "Risultato", metricOptions.find(([key]) => key === metric)[1]]) {
      const th = textEl("th", name);
      th.scope = "col";
      header.appendChild(th);
    }
    head.appendChild(header);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      const result = document.createElement("td");
      if (isAmrap) result.textContent = amrapLabel(row);
      else for (const set of row.sets) result.appendChild(textEl("div", `Serie ${set.set}: ${formatActualResult(set)}`));
      tr.append(textEl("td", dateLabel(row.completed_at)), result,
        textEl("td", row[metric] == null ? "Non registrato" : formatScore(row[metric])));
      body.appendChild(tr);
    }
    table.append(head, body);
    const wrap = document.createElement("div");
    wrap.className = "leaderboard-scroll";
    wrap.appendChild(table);
    container.append(wrap, textEl("p", `${rows.length} risultati caricati di ${series.workouts}. I migliori risultati considerano tutto lo storico; il grafico mostra i risultati caricati.`, "view-description"));
    if (data.more) {
      const more = createButton("Carica risultati precedenti", "btn btn-secondary");
      more.disabled = loading;
      more.addEventListener("click", () => { void load(true); });
      container.appendChild(more);
    }
  }
  function identityChanged() {
    const nextOwner = window.workoutLibrary.snapshot().userId;
    if (nextOwner === owner) return;
    request += 1;
    owner = nextOwner;
    selected = data = updatedAt = null;
    loading = false;
    error = "";
    render();
    void load();
  }
  function historyChanged() {
    if (!window.workoutLibrary.snapshot().historyLoading) void load();
  }
  window.addEventListener("workout-social-change", identityChanged);
  window.addEventListener("workout-history-change", historyChanged);
  render();
  void load();
  return () => {
    active = false;
    request += 1;
    window.removeEventListener("workout-social-change", identityChanged);
    window.removeEventListener("workout-history-change", historyChanged);
  };
}

function signedDelta(value, previous) {
  const delta = Number(value) - Number(previous);
  return `${delta > 0 ? "+" : ""}${formatScore(delta)}`;
}
