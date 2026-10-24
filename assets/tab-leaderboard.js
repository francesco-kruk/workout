function renderLeaderboard(container, { embedded = false, showProfile = true } = {}) {
  const social = window.workoutSocial;
  container.replaceChildren(textEl(embedded ? "h3" : "h2", "Classifica"));
  const status = textEl("p", "", "social-status");
  status.setAttribute("role", "status");
  const refresh = createButton("Aggiorna / riprova", "btn btn-secondary");
  refresh.addEventListener("click", () => { void social.refresh(); });
  const standings = document.createElement("section");
  standings.className = "social-panel";
  const month = textEl("h3", "");
  const personal = textEl("p", "", "view-description");
  const updated = textEl("p", "", "view-description");
  const wrap = document.createElement("div");
  wrap.className = "leaderboard-scroll";
  const table = document.createElement("table");
  table.className = "leaderboard";
  table.appendChild(textEl("caption", "Punti Aura mensili del gruppo"));
  const head = document.createElement("thead");
  const labels = document.createElement("tr");
  for (const label of ["Pos.", "Amico", "Aura Pts", "Giorni"]) {
    const cell = textEl("th", label);
    cell.scope = "col";
    labels.appendChild(cell);
  }
  head.appendChild(labels);
  const body = document.createElement("tbody");
  table.append(head, body);
  wrap.appendChild(table);
  standings.append(month, personal, updated, wrap);
  const account = document.createElement("form");
  account.className = "social-panel";
  const label = textEl("label", "Il tuo nome in classifica");
  const name = document.createElement("input");
  name.required = true;
  name.maxLength = 40;
  name.autocomplete = "nickname";
  label.appendChild(name);
  const save = createButton("Salva nome", "btn btn-secondary");
  save.type = "submit";
  account.append(label, save);
  account.addEventListener("submit", (event) => {
    event.preventDefault();
    void social.saveName(name.value);
  });
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
    "Accedi prima di allenarti e non cancellare i dati del browser prima della sincronizzazione. " +
    "Pesi, ripetizioni e risultati individuali restano privati e non influenzano i punti.", "view-description"));
  container.append(status, refresh, standings);
  if (showProfile) container.appendChild(account);
  container.appendChild(rules);
  let displayedUser;
  let displayedName;
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
    standings.hidden = account.hidden = !state.member;
    refresh.disabled = save.disabled = state.busy;
    if (state.user?.id !== displayedUser || state.member?.display_name !== displayedName) {
      name.value = state.member?.display_name || "";
      displayedUser = state.user?.id;
      displayedName = state.member?.display_name;
    }
    month.textContent = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric", timeZone: "Europe/Rome" })
      .format(state.rows[0]?.month_start ? new Date(`${state.rows[0].month_start}T12:00:00Z`) : new Date());
    const own = state.rows.find((row) => row.user_id === state.user?.id);
    personal.textContent = own ? rankingSummary(own) : "Nessuna classifica caricata.";
    updated.textContent = state.updatedAt
      ? `Ultimo aggiornamento: ${new Date(state.updatedAt).toLocaleString("it-IT")}. Solo presenze sincronizzate.`
      : "Aggiorna per caricare i Punti Aura del gruppo.";
    body.replaceChildren();
    for (const row of state.rows) {
      const tr = document.createElement("tr");
      if (row.user_id === state.user?.id) tr.className = "leaderboard-self";
      for (const value of [row.position, row.display_name, formatScore(row.points), row.gym_days]) {
        tr.appendChild(textEl("td", String(value)));
      }
      body.appendChild(tr);
    }
  }
  window.addEventListener("workout-social-change", update);
  update();
  void social.refresh();
  return () => window.removeEventListener("workout-social-change", update);
}

function formatScore(value) {
  return Number(value).toLocaleString("it-IT", { maximumFractionDigits: 2 });
}

function rankingSummary(row) {
  const weeks = Number(row.weekly_streak || 0);
  return `Sequenza settimanale: ${weeks} ${weeks === 1 ? "settimana" : "settimane"} · moltiplicatore dell'ultima settimana attiva: ${formatScore(row.multiplier)}×.`;
}
