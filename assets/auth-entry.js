function renderAuthEntry(container, screen) {
  const social = window.workoutSocial;
  const panel = document.createElement("section");
  panel.className = "social-panel auth-panel";
  const titles = {
    loading: "Accesso in corso...",
    "sign-in": "Accedi",
    pending: "Accesso in attesa di approvazione",
    "access-error": "Impossibile verificare l'accesso",
    "plan-error": "Impossibile caricare la tua scheda",
  };
  const heading = textEl("h2", titles[screen]);
  heading.tabIndex = -1;
  panel.appendChild(heading);
  const descriptions = {
    loading: "Stiamo verificando la sessione, l'accesso al gruppo e la tua scheda personale.",
    "sign-in": "Accedi con la tua email invitata per ritrovare la tua scheda e i tuoi progressi. Non serve una password.",
    pending: "Il tuo account è connesso, ma non è ancora approvato. Chiedi al proprietario di abilitarti al gruppo.",
    "access-error": "Non possiamo ancora aprire i tuoi dati. Controlla la connessione e riprova.",
    "plan-error": "Non è stato possibile recuperare la scheda personale. Riprova prima di creare una nuova scheda.",
  };
  panel.appendChild(textEl("p", descriptions[screen], "view-description"));
  const status = textEl("p", "", "social-status");
  status.setAttribute("role", "status");
  panel.appendChild(status);
  let submit = null;
  let email = null;
  if (screen === "sign-in") {
    const form = document.createElement("form");
    const label = textEl("label", "Email invitata");
    email = document.createElement("input");
    email.type = "email";
    email.name = "email";
    email.required = true;
    email.autocomplete = "email";
    label.appendChild(email);
    submit = createButton("Invia link di accesso", "btn btn-primary");
    submit.type = "submit";
    form.append(label, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void social.signIn(email.value.trim());
    });
    panel.appendChild(form);
  } else if (screen !== "loading") {
    submit = createButton("Aggiorna / riprova", "btn btn-primary");
    submit.addEventListener("click", () => { void social.refresh(); });
    panel.appendChild(submit);
  }
  const reload = createButton("Ricarica pagina", "btn btn-secondary");
  reload.addEventListener("click", () => location.reload());
  panel.appendChild(reload);
  container.replaceChildren(panel);

  function update() {
    const state = social.snapshot();
    const error = state.error || window.workoutLibrary.snapshot().error;
    status.textContent = error || state.notice || "";
    status.classList.toggle("error", Boolean(error));
    panel.setAttribute("aria-busy", String(screen === "loading" || state.busy));
    if (submit) {
      submit.disabled = state.busy;
      if (email) submit.textContent = state.busy ? "Invio del link..." : "Invia link di accesso";
    }
    if (email) email.disabled = state.busy;
    reload.hidden = !error;
  }
  window.addEventListener("workout-social-change", update);
  window.addEventListener("workout-library-status", update);
  update();
  heading.focus();
  return () => {
    window.removeEventListener("workout-social-change", update);
    window.removeEventListener("workout-library-status", update);
  };
}
