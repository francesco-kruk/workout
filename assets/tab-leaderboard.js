function renderLeaderboard(container) {
  const social = window.workoutSocial;
  container.replaceChildren(
    textEl("p", "La costanza fa squadra", "cycle-label"),
    textEl("h2", "Classifica"),
    textEl("p", "Ogni allenamento conta. Confronta i Punti Aura del mese e sostieni il tuo gruppo.", "view-description")
  );
  const overview = document.createElement("section");
  overview.className = "social-panel ranking-overview";
  overview.appendChild(textEl("p", "Il tuo mese", "cycle-label"));
  const month = textEl("h3", "");
  const monthly = document.createElement("div");
  const status = textEl("p", "", "social-status");
  status.setAttribute("role", "status");
  const refresh = createButton("Aggiorna / riprova", "btn btn-secondary");
  refresh.addEventListener("click", () => { void social.refresh(); });
  const standings = document.createElement("section");
  standings.className = "social-panel ranking-standings";
  const updated = textEl("p", "", "view-description");
  const wrap = document.createElement("div");
  wrap.className = "leaderboard-scroll";
  const table = document.createElement("table");
  table.className = "leaderboard";
  table.appendChild(textEl("caption", "Punti Aura mensili del gruppo"));
  const head = document.createElement("thead");
  const labels = document.createElement("tr");
  for (const [label, className] of [["Pos."], ["Amico"], ["Aura Pts", "aura-score"], ["Giorni"]]) {
    const cell = textEl("th", label, className);
    cell.scope = "col";
    labels.appendChild(cell);
  }
  head.appendChild(labels);
  const body = document.createElement("tbody");
  table.append(head, body);
  wrap.appendChild(table);
  standings.append(textEl("h3", "Il gruppo"), wrap);
  overview.append(month, monthly, updated, status, refresh);
  const manual = document.createElement("section");
  manual.className = "social-panel ranking-reviews";
  const rules = document.createElement("details");
  rules.className = "social-panel";
  rules.append(textEl("summary", "Regole e sincronizzazione"), textEl("p",
    "La stessa regola vale per tutti: almeno un allenamento nella settimana (lunedì–domenica, Europe/Rome). " +
    "Prima settimana attiva 1×, poi +0,25× per ogni settimana attiva consecutiva, fino a 3×. " +
    "Una settimana conclusa senza presenze interrompe la sequenza, non cancella i punti. " +
    "Ogni data vale 10 Punti Aura × il moltiplicatore della settimana, subito alla sincronizzazione. " +
    "Completa tutte le attività obbligatorie; completa o salta le serie opzionali. " +
    "Più allenamenti nella stessa data danno una sola presenza. La classifica riparte ogni mese, la sequenza continua. " +
    "Le presenze offline mantengono la data originale e possono ricalcolare la continuità e i punteggi successivi. " +
    "Gli allenamenti manuali contano solo dopo l'approvazione della maggioranza degli altri membri: " +
    "parità significa rifiuto. I punti usano la data del completamento, non quella del voto. " +
    "Accedi prima di allenarti e non cancellare i dati del browser prima della sincronizzazione. " +
    "Pesi, ripetizioni e risultati individuali restano privati e non influenzano i punti.", "view-description"));
  container.append(overview, standings, manual, rules);
  const cleanupManual = renderManualWorkouts(manual);
  function update() {
    const state = social.snapshot();
    let pending = 0;
    let storageError = "";
    try { pending = state.user ? pendingAttendance(state.user.id).length : 0; }
    catch (error) {
      console.error("Lettura presenze non riuscita.", error);
      storageError = error.message;
    }
    status.classList.toggle("error", Boolean(state.error || storageError));
    status.textContent = state.error || storageError || (!state.configured
      ? "Classifica non configurata. Gli allenamenti restano disponibili."
      : !state.ready ? "Connessione al gruppo..."
        : pending ? `${pending} presenze in attesa di sincronizzazione per questo account.`
          : state.notice || (state.member ? "Presenze sincronizzate." : "Account in attesa di approvazione."));
    standings.hidden = !state.member;
    refresh.disabled = state.busy;
    month.textContent = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric", timeZone: "Europe/Rome" })
      .format(state.rows[0]?.month_start ? new Date(`${state.rows[0].month_start}T12:00:00Z`) : new Date());
    const own = state.rows.find((row) => row.user_id === state.user?.id);
    monthly.replaceChildren();
    if (own) {
      const metrics = document.createElement("dl");
      metrics.className = "progress-metrics ranking-metrics";
      for (const [label, value, unit, className] of [
        ["Giorni di allenamento", own.gym_days],
        ["Punti Aura", formatScore(own.points), null, "aura-metric"],
        ["Sequenza settimanale", own.weekly_streak || 0, Number(own.weekly_streak) === 1 ? "settimana" : "settimane"],
        ["Moltiplicatore dell'ultima settimana attiva", `${formatScore(own.multiplier)}×`],
      ]) {
        const metric = document.createElement("div");
        if (className) metric.className = className;
        const result = textEl("dd", String(value));
        if (unit) result.appendChild(textEl("span", ` ${unit}`, "metric-unit"));
        metric.append(textEl("dt", label), result);
        metrics.appendChild(metric);
      }
      monthly.append(metrics, textEl("p", "Dati sincronizzati · giorni e Punti Aura del mese. Il moltiplicatore si applica subito; la sequenza settimanale continua tra mesi.", "view-description"));
    } else {
      monthly.appendChild(textEl("p", !state.configured
        ? "Le statistiche mensili richiedono l'accesso al gruppo."
        : "Statistiche mensili non ancora disponibili. Aggiorna per caricare i dati del gruppo.", "view-description"));
    }
    updated.textContent = state.updatedAt
      ? `Ultimo aggiornamento: ${new Date(state.updatedAt).toLocaleString("it-IT")}. Solo presenze sincronizzate.`
      : "Aggiorna per caricare i Punti Aura del gruppo.";
    body.replaceChildren();
    for (const row of state.rows) {
      const tr = document.createElement("tr");
      if (row.user_id === state.user?.id) {
        tr.className = "leaderboard-self";
        tr.setAttribute("aria-label", "La tua posizione");
      }
      for (const [value, className] of [[row.position], [row.display_name], [formatScore(row.points), "aura-score"], [row.gym_days]]) {
        tr.appendChild(textEl("td", String(value), className));
      }
      body.appendChild(tr);
    }
    if (!state.rows.length) {
      const empty = document.createElement("tr");
      const cell = textEl("td", "Nessuna classifica caricata.");
      cell.colSpan = 4;
      empty.appendChild(cell);
      body.appendChild(empty);
    }
  }
  window.addEventListener("workout-social-change", update);
  update();
  void social.refresh();
  return () => {
    window.removeEventListener("workout-social-change", update);
    cleanupManual();
  };
}
