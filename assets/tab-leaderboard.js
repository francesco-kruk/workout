function renderLeaderboard(container) {
  const social = window.workoutSocial;
  container.replaceChildren();
  container.append(
    textEl("p", "Il gruppo degli amici", "cycle-label"),
    textEl("h2", "Classifica"),
    textEl("p", "La costanza conta, una giornata alla volta.", "view-description")
  );

  const status = textEl("p", "", "social-status");
  status.setAttribute("role", "status");
  const account = document.createElement("section");
  account.className = "social-panel";
  const memberStatus = textEl("p", "", "view-description");
  const profile = document.createElement("form");
  const nameLabel = textEl("label", "Il tuo nome in classifica");
  const name = document.createElement("input");
  name.required = true;
  name.maxLength = 40;
  name.autocomplete = "nickname";
  nameLabel.appendChild(name);
  const save = createButton("Salva nome", "btn btn-secondary");
  save.type = "submit";
  profile.append(nameLabel, save);
  profile.addEventListener("submit", (event) => {
    event.preventDefault();
    void social.saveName(name.value);
  });
  const actions = document.createElement("div");
  actions.className = "workout-actions";
  const refresh = createButton("Aggiorna / riprova", "btn btn-primary");
  refresh.addEventListener("click", () => { void social.refresh(); });
  actions.append(refresh);
  account.append(memberStatus, profile, actions);

  const standings = document.createElement("section");
  standings.className = "social-panel";
  const month = textEl("h3", "");
  const personal = textEl("p", "", "view-description");
  const synced = textEl("p", "", "view-description");
  const tableWrap = document.createElement("div");
  tableWrap.className = "leaderboard-scroll";
  const table = document.createElement("table");
  table.className = "leaderboard";
  const caption = textEl("caption", "Punti mensili del gruppo");
  const head = document.createElement("thead");
  const labels = document.createElement("tr");
  for (const label of ["Pos.", "Amico", "Punti", "Giorni"]) {
    const cell = textEl("th", label);
    cell.scope = "col";
    labels.appendChild(cell);
  }
  head.appendChild(labels);
  const body = document.createElement("tbody");
  table.append(caption, head, body);
  tableWrap.appendChild(table);
  standings.append(month, personal, synced, tableWrap);

  const rules = textEl(
    "p",
    "Completa tutte le attività obbligatorie; completa o salta le serie opzionali. " +
      "Una sola presenza per data, nel fuso Europe/Rome. Ogni presenza vale 10 punti: " +
      "moltiplicatore iniziale 1×, +0,25 per allenamento nella sequenza, massimo 3×. " +
      "È consentito un giorno di riposo tra allenamenti; il riposo non dà punti. " +
      "I punti ripartono ogni mese, la sequenza continua. Il moltiplicatore mostrato è quello " +
      "dell'ultimo allenamento della sequenza attiva. Le presenze offline restano sul dispositivo " +
      "e si sincronizzano con la data originale: accedi al gruppo prima di allenarti. " +
      "Non cancellare i dati del browser prima della sincronizzazione. La gara si basa sulla fiducia.",
    "view-description"
  );
  const ruleDetails = document.createElement("details");
  ruleDetails.className = "social-panel";
  ruleDetails.append(textEl("summary", "Regole e sincronizzazione"), rules);
  container.append(status, standings, account, ruleDetails);
  let displayedUser = null;
  let displayedName = null;

  function update() {
    const state = social.snapshot();
    let pending = 0;
    let storageError = "";
    try {
      pending = state.user ? pendingAttendance(state.user.id).length : 0;
    } catch (error) {
      console.error("Lettura presenze non riuscita.", error);
      storageError = error.message;
    }
    status.classList.toggle("error", Boolean(state.error || storageError));
    status.textContent = state.error || storageError || (!state.configured
      ? "Classifica non configurata. Gli allenamenti restano disponibili."
      : !state.ready ? "Connessione al gruppo..."
        : state.notice || (pending
          ? `${pending} presenze in attesa di sincronizzazione per questo account.`
          : state.member ? "Presenze sincronizzate." : ""));
    account.hidden = !state.user;
    profile.hidden = !state.member;
    standings.hidden = !state.member;
    save.disabled = refresh.disabled = state.busy;
    memberStatus.textContent = state.member
      ? `Accesso come ${state.member.display_name}. ${pending} presenze in attesa.`
      : "Account connesso, in attesa di approvazione al gruppo. Chiedi al proprietario di abilitarti.";
    if (state.user?.id !== displayedUser || state.member?.display_name !== displayedName) {
      name.value = state.member?.display_name || "";
      displayedUser = state.user?.id;
      displayedName = state.member?.display_name;
    }
    const firstDay = state.rows[0]?.month_start;
    const monthDate = firstDay ? new Date(`${firstDay}T12:00:00Z`) : new Date();
    month.textContent = new Intl.DateTimeFormat("it-IT", {
      month: "long", year: "numeric", timeZone: "Europe/Rome",
    }).format(monthDate);
    const own = state.rows.find((row) => row.user_id === state.user?.id);
    personal.textContent = own
      ? `La tua sequenza: ${own.current_streak} allenamenti · moltiplicatore ${formatScore(own.multiplier)}×`
      : "Nessuna classifica caricata.";
    synced.textContent = state.updatedAt
      ? `Ultimo aggiornamento: ${new Date(state.updatedAt).toLocaleString("it-IT")}. I punti includono solo le presenze sincronizzate.`
      : "Aggiorna per caricare i punti del gruppo.";
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
