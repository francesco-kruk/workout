function renderLeaderboard(container, { embedded = false, showProfile = true } = {}) {
  const social = window.workoutSocial;
  container.replaceChildren();
  container.append(
    textEl(embedded ? "h3" : "h2", "Classifica"),
    textEl("p", "La costanza conta, una giornata alla volta.", "view-description")
  );

  const status = textEl("p", "", "social-status");
  status.setAttribute("role", "status");
  const account = document.createElement("details");
  account.className = "social-panel";
  account.appendChild(textEl("summary", "Profilo nel gruppo"));
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
  actions.className = "editor-actions";
  const refresh = createButton("Aggiorna / riprova", "btn btn-primary");
  refresh.addEventListener("click", () => { void social.refresh(); });
  actions.append(refresh);
  account.append(memberStatus, profile);

  const standings = document.createElement("section");
  standings.className = "social-panel";
  const month = textEl("h3", "");
  const personal = textEl("p", "", "view-description");
  const synced = textEl("p", "", "view-description");
  const tableWrap = document.createElement("div");
  tableWrap.className = "leaderboard-scroll";
  const table = document.createElement("table");
  table.className = "leaderboard";
  const caption = textEl("caption", "Punti Aura mensili del gruppo");
  const head = document.createElement("thead");
  const labels = document.createElement("tr");
  for (const label of ["Pos.", "Amico", "Aura Pts", "Giorni"]) {
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
      "Una sola presenza per data, nel fuso Europe/Rome. Ogni presenza vale 10 Punti Aura. " +
      "Le settimane vanno da lunedì a domenica: i bonus degli obiettivi approvati si sommano " +
      "al moltiplicatore base 1× e vengono conteggiati dal lunedì successivo. " +
      "La settimana in corso dà subito i Punti Aura base; i bonus sono provvisori. " +
      "Nessun limite ai giorni di riposo. La costanza settimanale cresce fino al tetto approvato; " +
      "una settimana senza presenze interrompe solo la sequenza, non cancella i Punti Aura guadagnati. " +
      "La classifica riparte ogni mese, la sequenza settimanale continua. " +
      "I bonus restano nel mese della presenza, anche se la settimana finisce nel mese dopo. " +
      "Le presenze offline restano sul dispositivo " +
      "e si sincronizzano con la data originale: accedi al gruppo prima di allenarti. " +
      "Non cancellare i dati del browser prima della sincronizzazione. La gara si basa sulla fiducia.",
    "view-description"
  );
  const ruleDetails = document.createElement("details");
  ruleDetails.className = "social-panel";
  ruleDetails.append(textEl("summary", "Regole e sincronizzazione"), rules);
  container.append(status, actions, standings);
  if (showProfile) container.appendChild(account);
  container.appendChild(ruleDetails);
  const objectivesPanel = document.createElement("section");
  objectivesPanel.className = "social-panel ranking-objectives";
  container.appendChild(objectivesPanel);
  const objectiveView = createRankingObjectives(objectivesPanel, social);
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
    status.classList.toggle("error", Boolean(state.error || storageError || state.objectivesError));
    status.textContent = state.error || storageError || state.objectivesError || (!state.configured
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
    personal.textContent = own ? rankingSummary(own) : "Nessuna classifica caricata.";
    synced.textContent = state.updatedAt
      ? `Ultimo aggiornamento: ${new Date(state.updatedAt).toLocaleString("it-IT")}. I Punti Aura includono solo le presenze sincronizzate.`
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
    objectiveView.update(state);
  }

  window.addEventListener("workout-social-change", update);
  update();
  void social.refresh();
  return () => {
    window.removeEventListener("workout-social-change", update);
    objectiveView.dispose();
  };
}

function formatScore(value) {
  return Number(value).toLocaleString("it-IT", { maximumFractionDigits: 2 });
}

function rankingSummary(row) {
  if (!row.cutover || row.week_start < row.cutover) {
    return `Regole precedenti fino al ${row.cutover || "passaggio agli obiettivi"}: sequenza di ${row.current_streak} allenamenti · moltiplicatore ${formatScore(row.multiplier)}×.`;
  }
  return `Sequenza settimanale: ${row.weekly_streak} ${Number(row.weekly_streak) === 1 ? "settimana" : "settimane"} · ultimo moltiplicatore liquidato ${formatScore(row.settled_multiplier)}×` +
    ` · bonus provvisorio della settimana: ${formatScore(row.pending_bonus)} Punti Aura (dal ${row.settles_on}).`;
}

const RANKING_WEEKDAYS = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];

function rankingObjectiveDescription(rules) {
  const lines = [];
  if (rules.streak) lines.push(`Costanza: +${formatScore(rules.streak.step)}× per settimana consecutiva con almeno una presenza, tetto +${formatScore(rules.streak.cap)}×.`);
  if (rules.count) lines.push(`Frequenza: almeno ${rules.count.days} giorni a settimana, +${formatScore(rules.count.bonus)}×.`);
  if (rules.schedule) lines.push(`Calendario: ${rules.schedule.days.map((day) => RANKING_WEEKDAYS[day - 1]).join(", ")}, +${formatScore(rules.schedule.bonus)}×. Giorni aggiuntivi consentiti.`);
  return lines.length ? lines.join(" ") : "Nessun obiettivo approvato: moltiplicatore base 1×.";
}

function validateRankingObjectives(rules) {
  if (!rules || typeof rules !== "object" || Array.isArray(rules) || !Object.keys(rules).length) return "Seleziona almeno un obiettivo.";
  for (const [kind, rule] of Object.entries(rules)) {
    if (!["streak", "count", "schedule"].includes(kind)) return "Tipo di obiettivo non valido.";
    const expected = kind === "streak" ? ["step", "cap"] : ["days", "bonus"];
    if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
      Object.keys(rule).length !== expected.length || !expected.every((field) => Object.hasOwn(rule, field))) {
      return "Definizione obiettivo non valida.";
    }
    for (const field of kind === "streak" ? ["step", "cap"] : ["bonus"]) {
      const value = rule[field];
      if (!Number.isFinite(value) || value < 0.01 || value > 999.99 || Math.round(value * 100) / 100 !== value) {
        return "I bonus devono essere tra 0,01 e 999,99, con massimo due decimali.";
      }
    }
    if (kind === "streak" && rule.cap < rule.step) return "Il tetto deve essere almeno pari al bonus per settimana.";
    if (kind === "count" && (!Number.isInteger(rule.days) || rule.days < 1 || rule.days > 7)) return "Scegli da 1 a 7 giorni a settimana.";
    if (kind === "schedule" && (!Array.isArray(rule.days) || !rule.days.length ||
      new Set(rule.days).size !== rule.days.length || rule.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7))) {
      return "Seleziona almeno un giorno del calendario, senza duplicati.";
    }
  }
  return "";
}

function rankingMaximumMultiplier(rules) {
  return 1 + (rules.streak?.cap || 0) + (rules.count?.bonus || 0) + (rules.schedule?.bonus || 0);
}

function createRankingObjectives(container, social) {
  const owner = social.snapshot().user?.id;
  let disposed = false;
  let request = null;
  container.append(textEl("h3", "Obiettivi e Punti Aura"));
  const transition = textEl("p", "", "view-description");
  const feedback = textEl("p", "", "social-status");
  feedback.setAttribute("role", "status");
  const packages = document.createElement("div");
  packages.className = "objective-packages";
  const editor = document.createElement("details");
  editor.append(textEl("summary", "Proponi i tuoi obiettivi"));
  const form = document.createElement("form");
  form.className = "objective-form";
  form.append(textEl("p", "Scegli gli obiettivi e proponi i bonus. Serve la maggioranza degli altri membri: con tre persone, entrambi gli amici devono approvare. I voti non si possono cambiare. Le nuove regole partono il lunedì dopo l'approvazione.", "view-description"));
  form.append(textEl("p", "Bonus da 0,01 a 999,99, massimo due decimali. Nessun tetto globale 3×: il gruppo valuta la difficoltà e il massimo del pacchetto.", "view-description"));
  const fields = {};
  function numeric(parent, label, name, value, max = 999.99, step = 0.01) {
    const wrap = textEl("label", label);
    const input = document.createElement("input");
    input.type = "number";
    input.name = name;
    input.min = step;
    input.max = max;
    input.step = step;
    input.required = true;
    input.value = value;
    wrap.append(input);
    parent.append(wrap);
    return input;
  }
  for (const [kind, title] of [["streak", "Costanza tra settimane"], ["count", "Giorni a settimana"], ["schedule", "Calendario settimanale"]]) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    const label = textEl("label", title);
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.name = `enable-${kind}`;
    label.prepend(enabled);
    legend.append(label);
    group.append(legend);
    const controls = document.createElement("div");
    controls.className = "objective-fields";
    const item = { enabled, controls };
    fields[kind] = item;
    if (kind === "streak") {
      controls.append(textEl("p", "Ogni settimana con almeno una presenza aggiunge un passo, fino al tetto. Una settimana vuota interrompe la sequenza.", "view-description"));
      item.step = numeric(controls, "Bonus per settimana consecutiva (+×)", "streak-step", 0.25);
      item.cap = numeric(controls, "Tetto del bonus costanza (+×)", "streak-cap", 1);
    } else {
      if (kind === "count") item.days = numeric(controls, "Minimo giorni di allenamento", "count-days", 3, 7, 1);
      else {
        item.days = RANKING_WEEKDAYS.map((day, index) => {
          const dayLabel = textEl("label", day);
          const input = document.createElement("input");
          input.type = "checkbox";
          input.name = "schedule-days";
          input.value = index + 1;
          dayLabel.prepend(input);
          controls.append(dayLabel);
          return input;
        });
      }
      item.bonus = numeric(controls, "Bonus obiettivo raggiunto (+×)", `${kind}-bonus`, 0.5);
    }
    group.append(controls);
    form.append(group);
  }
  const preview = textEl("p", "", "view-description");
  const unavailable = textEl("p", "", "view-description");
  const submit = createButton("Invia proposta", "btn btn-primary");
  submit.type = "submit";
  form.append(preview, unavailable, submit);
  editor.append(form);
  const proposals = document.createElement("div");
  container.append(transition, editor, feedback, proposals, packages);

  function readRules() {
    const rules = {};
    if (fields.streak.enabled.checked) rules.streak = { step: Number(fields.streak.step.value), cap: Number(fields.streak.cap.value) };
    if (fields.count.enabled.checked) rules.count = { days: Number(fields.count.days.value), bonus: Number(fields.count.bonus.value) };
    if (fields.schedule.enabled.checked) rules.schedule = {
      days: fields.schedule.days.filter((day) => day.checked).map((day) => Number(day.value)),
      bonus: Number(fields.schedule.bonus.value),
    };
    return rules;
  }
  function updateForm(state) {
    const own = state.objectives?.proposals.filter((p) => p.user_id === owner) || [];
    const pending = own.some((p) => p.status === "pending");
    const scheduled = own.some((p) => p.status === "approved" && p.effective_from > state.objectives.week_start);
    const blocked = state.busy || !state.objectives || Boolean(state.objectivesError) || pending || scheduled;
    unavailable.textContent = pending ? "Ritira la proposta in attesa prima di sostituirla."
      : scheduled ? "Hai già un pacchetto approvato in programma. Attendi l'attivazione per proporre altri cambiamenti."
        : !state.objectives || state.objectivesError ? "Aggiorna gli obiettivi prima di inviare una proposta." : "";
    for (const item of Object.values(fields)) {
      item.enabled.disabled = blocked;
      item.controls.hidden = !item.enabled.checked;
      for (const control of item.controls.querySelectorAll("input")) control.disabled = blocked || !item.enabled.checked;
    }
    submit.disabled = blocked;
    form.setAttribute("aria-busy", String(state.busy));
    const rules = readRules();
    const error = validateRankingObjectives(rules);
    const max = rankingMaximumMultiplier(rules);
    preview.textContent = error || `Massimo proposto: ${formatScore(max)}×. Esempio: 3 presenze con tutti i bonus al massimo = ${formatScore(30 * max)} Punti Aura.`;
  }
  form.addEventListener("input", () => updateForm(social.snapshot()));
  function showResult(result) {
    if (disposed || social.snapshot().user?.id !== owner) return;
    feedback.textContent = result.ok ? result.message : result.error;
    feedback.classList.toggle("error", !result.ok);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (disposed || social.snapshot().user?.id !== owner || submit.disabled) return;
    const rules = readRules();
    const error = validateRankingObjectives(rules);
    if (error) { showResult({ ok: false, error }); return; }
    if (!form.reportValidity()) return;
    const serialized = JSON.stringify(rules);
    if (request?.serialized !== serialized) request = { id: crypto.randomUUID(), serialized };
    const result = await social.proposeObjectives(request.id, rules);
    if (result.ok) request = null;
    showResult(result);
  });

  function update(state) {
    container.hidden = !state.member || state.user?.id !== owner;
    if (state.user?.id !== owner) {
      form.reset();
      request = null;
      feedback.textContent = "";
      packages.replaceChildren();
      proposals.replaceChildren();
      return;
    }
    const data = state.objectives;
    transition.textContent = data ? `Nuove regole dal ${data.cutover}. Settimana ${data.week_start} – liquidazione bonus ${data.settles_on} (Europe/Rome). Prima del passaggio restano le regole precedenti: +0,25× per presenza ravvicinata, massimo 3× e un solo giorno di riposo. I Punti Aura precedenti sono conservati.`
      : "Gli obiettivi richiedono una connessione al gruppo.";
    updateForm(state);
    packages.replaceChildren(textEl("h4", "Obiettivi attivi del gruppo"));
    proposals.replaceChildren(textEl("h4", "Proposte del gruppo"));
    if (!data) return;
    for (const row of state.rows) {
      const card = document.createElement("details");
      card.className = "objective-card";
      card.open = row.user_id === owner;
      card.append(textEl("summary", row.display_name));
      const approved = data.proposals.filter((p) => p.user_id === row.user_id && p.status === "approved");
      const active = approved.filter((p) => p.effective_from <= data.week_start)
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
      card.append(textEl("p", rankingObjectiveDescription(active?.rules || {}), "view-description"));
      if (active) card.append(textEl("p", `In vigore dal ${active.effective_from}.`, "view-description"));
      for (const scheduled of approved.filter((p) => p.effective_from > data.week_start)) {
        card.append(textEl("p", `Approvato, dal ${scheduled.effective_from}: ${rankingObjectiveDescription(scheduled.rules)}`, "view-description"));
      }
      if (row.week_start >= row.cutover) {
        card.append(textEl("p", `Questa settimana: ${row.week_days.length} ${row.week_days.length === 1 ? "giorno" : "giorni"} (${row.week_days.map((d) => RANKING_WEEKDAYS[d - 1]).join(", ") || "nessuno"}). Sequenza: ${row.weekly_streak} ${Number(row.weekly_streak) === 1 ? "settimana" : "settimane"}.`, "view-description"));
        const bonuses = row.current_bonuses;
        const rules = active?.rules || {};
        if (rules.streak) card.append(textEl("p", `Costanza: +${formatScore(bonuses.streak)}× provvisori (tetto +${formatScore(rules.streak.cap)}×).`, "view-description"));
        if (rules.count) card.append(textEl("p", `Frequenza: ${row.week_days.length}/${rules.count.days} giorni · +${formatScore(bonuses.count)}× provvisori.`, "view-description"));
        if (rules.schedule) {
          const missing = rules.schedule.days.filter((d) => !row.week_days.includes(d)).map((d) => RANKING_WEEKDAYS[d - 1]);
          card.append(textEl("p", `Calendario: ${missing.length ? `mancano ${missing.join(", ")}` : "completato"} · +${formatScore(bonuses.schedule)}× provvisori.`, "view-description"));
        }
        card.append(textEl("p", `Ultimo moltiplicatore liquidato: ${formatScore(row.settled_multiplier)}×. Bonus della settimana in attesa: ${formatScore(row.pending_bonus)} Punti Aura.`, "view-description"));
      }
      packages.append(card);
    }
    if (!data.proposals.length) proposals.append(textEl("p", "Nessuna proposta. Proponi i tuoi primi obiettivi.", "view-description"));
    const labels = { pending: "In votazione", approved: "Approvata", rejected: "Respinta", withdrawn: "Ritirata", invalidated: "Da ripresentare: un votante ha lasciato il gruppo" };
    for (const proposal of data.proposals) {
      const card = document.createElement("details");
      card.className = "objective-card";
      card.dataset.proposalId = proposal.id;
      card.open = proposal.status === "pending";
      card.append(textEl("summary", `${proposal.display_name} · ${labels[proposal.status]}`));
      card.append(textEl("p", rankingObjectiveDescription(proposal.rules), "view-description"));
      card.append(textEl("p", `Massimo del pacchetto: ${formatScore(rankingMaximumMultiplier(proposal.rules))}×.`, "view-description"));
      const approvals = proposal.votes.filter((v) => v.approve).length;
      card.append(textEl("p", `${approvals}/${proposal.required_approvals} approvazioni richieste su ${proposal.electorate.length} votanti. Il proponente non vota.`, "view-description"));
      if (proposal.effective_from) card.append(textEl("p", `Decorrenza: ${proposal.effective_from}.`, "view-description"));
      for (const voter of proposal.electorate) {
        const vote = proposal.votes.find((v) => v.voter_id === voter);
        card.append(textEl("p", `${proposal.voter_names[voter]}: ${vote ? vote.approve ? "Approva" : "Rifiuta" : "In attesa"}.`, "view-description"));
      }
      const actions = document.createElement("div");
      actions.className = "editor-actions";
      function action(label, operation) {
        const button = createButton(label, "btn btn-secondary");
        button.disabled = state.busy || Boolean(state.objectivesError);
        button.addEventListener("click", async () => {
          if (disposed || social.snapshot().user?.id !== owner) return;
          showResult(await operation());
        });
        actions.append(button);
      }
      if (proposal.status === "pending") {
        if (proposal.user_id === owner) action("Ritira proposta", () => social.withdrawObjectives(proposal.id));
        else if (proposal.electorate.includes(owner) && !proposal.votes.some((v) => v.voter_id === owner)) {
          action("Approva", () => social.voteObjectives(proposal.id, true));
          action("Rifiuta", () => social.voteObjectives(proposal.id, false));
        }
      }
      card.append(actions);
      proposals.append(card);
    }
  }
  return { update, dispose() { disposed = true; request = null; } };
}
