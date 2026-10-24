function renderManualWorkoutForm(plan, session) {
  const library = window.workoutLibrary.snapshot();
  const social = window.workoutSocial.snapshot();
  if (!social.member || !library.record || library.plan !== plan) return null;
  const owner = social.user.id;
  const versionId = library.record.id;
  const key = `workout.manualIntent:${owner}:${versionId}`;
  const panel = document.createElement("details");
  panel.className = "social-panel manual-workout";
  panel.appendChild(textEl("summary", "Allenamento alternativo / manuale"));
  const form = document.createElement("form");
  form.dataset.manualWorkout = "";
  const descriptionLabel = textEl("label", "Descrivi cosa hai fatto");
  const description = document.createElement("textarea");
  description.name = "description";
  description.required = true;
  description.maxLength = 2000;
  description.rows = 4;
  descriptionLabel.appendChild(description);
  const choiceLabel = textEl("label", "Cosa succede alla giornata pianificata?");
  const choice = document.createElement("select");
  choice.name = "progression";
  choice.required = true;
  for (const [value, label] of [
    ["", "Scegli un'opzione"],
    ["replace", "Sostituisci: passa alla prossima giornata"],
    ["extra", "Extra: mantieni questa giornata come prossima"],
  ]) {
    const option = textEl("option", label);
    option.value = value;
    choice.appendChild(option);
  }
  choiceLabel.appendChild(choice);
  const submit = createButton("Completato: invia in revisione", "btn btn-primary");
  submit.type = "submit";
  const status = textEl("p", "", "social-status");
  status.setAttribute("role", "status");
  form.append(
    textEl("p", "Descrizione, data e scelta saranno condivise con il gruppo. Non inserire informazioni riservate. " +
      "Invia solo dopo aver finito: l'orario è registrato automaticamente. " +
      "Servono i voti favorevoli di più della metà degli altri membri; parità significa rifiuto. " +
      "Nessun punto prima dell'approvazione. La scelta del piano vale subito e non cambia in caso di rifiuto. " +
      "Richieste e voti non sono modificabili. Invio e voto richiedono internet.", "view-description"),
    descriptionLabel, choiceLabel, submit, status
  );
  panel.appendChild(form);
  let intent = null;
  let busy = false;
  let blocked = false;
  function feedback(error) {
    console.error("Invio allenamento manuale non riuscito.", error);
    status.textContent = error.message;
    status.classList.add("error");
    panel.open = true;
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      intent = JSON.parse(raw);
      if (!intent || typeof intent.id !== "string" || intent.planVersionId !== versionId
        || !plan.sessions.some((day) => day.id === intent.sessionId) || typeof intent.description !== "string"
        || typeof intent.replacesPlanned !== "boolean" || !(intent.runId === null || typeof intent.runId === "string")) {
        throw new Error("Richiesta locale non valida. Conserva i dati e contatta il gestore.");
      }
      description.value = intent.description;
      choice.value = intent.replacesPlanned ? "replace" : "extra";
      description.disabled = choice.disabled = true;
      submit.textContent = "Recupera / riprova lo stesso invio";
      status.textContent = "Invio precedente da verificare. Il recupero non crea una seconda richiesta.";
      panel.open = true;
    }
  } catch (error) {
    blocked = true;
    submit.disabled = true;
    feedback(error);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || blocked || !form.reportValidity()) return;
    busy = true;
    submit.disabled = true;
    status.textContent = "";
    status.classList.remove("error");
    try {
      if (!navigator.onLine) throw new Error("Torna online per inviare. Nessuna richiesta è stata accodata.");
      if (window.workoutSocial.snapshot().user?.id !== owner
        || window.workoutLibrary.snapshot().record?.id !== versionId) {
        throw new Error("Account o piano cambiato. Riapri Allenamento.");
      }
      if (!intent) {
        const text = description.value.trim();
        if (!text) throw new Error("Descrivi cosa hai fatto.");
        if (getCurrentSessionId(plan) !== session.id || getSessionSummary(plan, session).complete
          || hasRecordedWorkout(getProgress(session.id).runId)) {
          throw new Error("La giornata è cambiata o è già stata completata. Riapri Allenamento.");
        }
        const nextIntent = {
          id: crypto.randomUUID(), planVersionId: versionId, sessionId: session.id,
          runId: getProgress(session.id).runId, description: text, replacesPlanned: choice.value === "replace",
        };
        localStorage.setItem(key, JSON.stringify(nextIntent));
        intent = nextIntent;
      }
      description.disabled = choice.disabled = true;
      const row = await window.workoutSocial.submitManualWorkout(intent);
      if (window.workoutSocial.snapshot().user?.id !== owner
        || window.workoutLibrary.snapshot().record?.id !== versionId) {
        throw new Error("Richiesta inviata. Recuperala con l'account e il piano originali per aggiornare la giornata.");
      }
      let message = row.status === "approved"
        ? "Allenamento già approvato: presenza accreditata alla data originale."
        : row.status === "rejected" ? "Allenamento registrato ma rifiutato: nessun punto."
          : "Allenamento inviato in revisione. Nessun punto finché non viene approvato.";
      const applied = readProgressStore().manualApplied?.[intent.id];
      if (!applied && (getCurrentSessionId(plan) !== intent.sessionId || getProgress(intent.sessionId).runId !== intent.runId
        || getSessionSummary(plan, plan.sessions.find((day) => day.id === intent.sessionId)).complete)) {
        message += " La giornata è cambiata durante l'invio: il piano non è stato modificato.";
      } else {
        window.dispatchEvent(new Event("workout-manual-will-complete"));
        applyManualWorkoutProgress(plan, intent);
      }
      localStorage.removeItem(key);
      window.dispatchEvent(new CustomEvent("workout-manual-complete", { detail: { message } }));
      window.dispatchEvent(new Event("workout-library-status"));
    } catch (error) {
      feedback(error);
      submit.textContent = intent ? "Recupera / riprova lo stesso invio" : "Completato: invia in revisione";
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });
  return panel;
}

function renderManualWorkouts(container) {
  const owner = window.workoutSocial.snapshot().user?.id;
  let active = true;
  let busy = false;
  let error = "";
  let notice = "";
  let refreshAgain = false;
  const lists = [
    { own: false, title: "Da approvare", rows: [], more: false },
    { own: true, title: "I tuoi allenamenti manuali", rows: [], more: false },
  ];
  const statusLabel = { pending: "In revisione", approved: "Approvato", rejected: "Rifiutato" };
  const current = () => active && window.document && window.workoutSocial.snapshot().user?.id === owner;
  async function load(list = null) {
    if (busy || !current() || !window.workoutSocial.snapshot().member) return;
    busy = true;
    error = "";
    render();
    try {
      const targets = list ? [list] : lists;
      const pages = await Promise.all(targets.map((item) =>
        window.workoutSocial.fetchManualWorkouts(item.own, list ? item.rows.at(-1) : null)));
      if (!current()) return;
      targets.forEach((item, index) => {
        item.rows = list ? [...item.rows, ...pages[index].filter((row) => !item.rows.some((old) => old.id === row.id))] : pages[index];
        item.more = pages[index].length === 20;
      });
    } catch (failure) {
      if (!current()) return;
      console.error("Caricamento revisioni non riuscito.", failure);
      error = `Revisioni non aggiornate. ${failure.message}`;
    } finally {
      busy = false;
      if (current()) {
        render();
        if (refreshAgain) { refreshAgain = false; void load(); }
      }
    }
  }
  async function vote(row, approve) {
    if (busy || !current()) return;
    busy = true;
    row.retryVote = approve;
    error = notice = "";
    render();
    try {
      const result = await window.workoutSocial.voteManualWorkout(row.id, approve);
      if (!current()) return;
      row.own_vote = approve;
      Object.assign(row, result);
      delete row.retryVote;
      notice = `Voto salvato: ${approve ? "approvazione" : "rifiuto"}. ${statusLabel[result.status]}.`;
    } catch (failure) {
      if (!current()) return;
      console.error("Voto non riuscito.", failure);
      error = `Voto non confermato. Riprova lo stesso voto o aggiorna. ${failure.message}`;
    } finally {
      busy = false;
      if (current()) {
        render();
        if (refreshAgain) { refreshAgain = false; void load(); }
      }
    }
  }
  function render() {
    if (!current()) return;
    container.replaceChildren(textEl("h3", "Allenamenti manuali · revisione del gruppo"));
    if (!window.workoutSocial.snapshot().member) {
      container.appendChild(textEl("p", "Le revisioni richiedono l'accesso al gruppo.", "view-description"));
      return;
    }
    container.appendChild(textEl("p",
      "Descrizioni condivise con il gruppo, non parte dello storico privato. " +
      "Serve più della metà di tutti gli altri membri presenti all'invio; parità o maggioranza impossibile = rifiuto. " +
      "Nessuna scadenza automatica. Se un votante lascia il gruppo, le richieste pendenti interessate sono rifiutate. " +
      "L'approvazione accredita la data originale (Europe/Rome), con al massimo una presenza per data.", "view-description"));
    const status = textEl("p", error || notice || (busy ? "Aggiornamento revisioni..." : ""), `social-status${error ? " error" : ""}`);
    status.setAttribute("role", "status");
    const refresh = createButton("Aggiorna revisioni", "btn btn-secondary");
    refresh.disabled = busy;
    refresh.addEventListener("click", () => { void load(); });
    container.append(status, refresh);
    for (const list of lists) {
      const section = document.createElement("section");
      section.appendChild(textEl("h4", list.title));
      if (!list.rows.length && !busy) section.appendChild(textEl("p", error ? "Elenco non disponibile." : "Nessuna richiesta.", "view-description"));
      for (const row of list.rows) {
        const card = document.createElement("article");
        card.className = "manual-review";
        card.append(
          textEl("h5", `${row.display_name} · ${statusLabel[row.status]}`),
          textEl("p", new Date(row.completed_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" }), "view-description"),
          textEl("p", row.description, "manual-description"),
          textEl("p", row.replaces_planned ? "Sostituisce la giornata pianificata." : "Allenamento extra; giornata pianificata conservata.", "view-description"),
          textEl("p", `${row.approvals} favorevoli · ${row.rejections} contrari · servono ${row.required_approvals} su ${row.voters}.`, "view-description")
        );
        if (row.reason === "voter_left") card.appendChild(textEl("p", "Un votante ha lasciato il gruppo."));
        if (row.own_vote !== null) card.appendChild(textEl("p", `Il tuo voto: ${row.own_vote ? "approva" : "rifiuta"}.`));
        if (row.decided_at) card.appendChild(textEl("p", `Decisione: ${new Date(row.decided_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" })}`, "view-description"));
        if (!list.own && row.status === "pending" && row.eligible && row.own_vote === null) {
          const actions = document.createElement("div");
          actions.className = "editor-actions";
          for (const [approve, label] of [[true, "Approva"], [false, "Rifiuta"]]) {
            const button = createButton(label, "btn btn-secondary");
            button.disabled = busy || (row.retryVote !== undefined && row.retryVote !== approve);
            button.addEventListener("click", () => { void vote(row, approve); });
            actions.appendChild(button);
          }
          card.appendChild(actions);
        }
        section.appendChild(card);
      }
      if (list.more) {
        const more = createButton(`Carica precedenti · ${list.title}`, "btn btn-secondary");
        more.disabled = busy;
        more.addEventListener("click", () => { void load(list); });
        section.appendChild(more);
      }
      container.appendChild(section);
    }
  }
  function identityChanged() {
    if (!current()) {
      active = false;
      container.replaceChildren();
    }
  }
  window.addEventListener("workout-social-change", identityChanged);
  function completed() {
    if (busy) refreshAgain = true;
    else void load();
  }
  window.addEventListener("workout-manual-complete", completed);
  render();
  void load();
  return () => {
    active = false;
    window.removeEventListener("workout-social-change", identityChanged);
    window.removeEventListener("workout-manual-complete", completed);
  };
}
