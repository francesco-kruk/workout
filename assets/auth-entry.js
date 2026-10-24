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
    "sign-in": "Accedi con email e password per ritrovare la tua scheda e i tuoi progressi.",
    pending: "Il tuo account è connesso, ma non è ancora approvato. Chiedi al proprietario di abilitarti al gruppo.",
    "access-error": "Non possiamo ancora aprire i tuoi dati. Controlla la connessione e riprova.",
    "plan-error": "Non è stato possibile recuperare la scheda personale. Riprova prima di creare una nuova scheda.",
  };
  const description = textEl("p", descriptions[screen], "view-description");
  panel.appendChild(description);
  const status = textEl("p", "", "social-status");
  status.setAttribute("role", "status");
  panel.appendChild(status);
  let submit = null;
  let email = null;
  let password = null;
  let toggle = null;
  let creatingAccount = false;
  if (screen === "sign-in") {
    const form = document.createElement("form");
    const label = textEl("label", "Email");
    email = document.createElement("input");
    email.type = "email";
    email.name = "email";
    email.required = true;
    email.autocomplete = "username";
    label.appendChild(email);
    const passwordLabel = textEl("label", "Password");
    password = document.createElement("input");
    password.type = "password";
    password.name = "password";
    password.required = true;
    password.autocomplete = "current-password";
    passwordLabel.appendChild(password);
    submit = createButton("Accedi", "btn btn-primary");
    submit.type = "submit";
    form.append(label, passwordLabel, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (social.snapshot().busy || !form.reportValidity()) return;
      if (creatingAccount) void social.signUp(email.value.trim(), password.value);
      else void social.signIn(email.value.trim(), password.value);
    });
    toggle = createButton("Crea un account", "btn btn-secondary");
    toggle.addEventListener("click", () => {
      creatingAccount = !creatingAccount;
      password.value = "";
      password.autocomplete = creatingAccount ? "new-password" : "current-password";
      if (creatingAccount) password.minLength = 8;
      else password.removeAttribute("minlength");
      heading.textContent = creatingAccount ? "Crea un account" : titles[screen];
      description.textContent = creatingAccount
        ? "Scegli email e password (almeno 8 caratteri). Dopo la registrazione, il proprietario deve approvare il tuo accesso al gruppo."
        : descriptions[screen];
      toggle.textContent = creatingAccount ? "Hai già un account? Accedi" : "Crea un account";
      update();
      heading.focus();
    });
    panel.append(form, toggle, textEl("p",
      "Se hai già un account senza password o l'hai dimenticata, contatta il proprietario.",
      "view-description"));
  } else if (screen !== "loading") {
    submit = createButton("Aggiorna / riprova", "btn btn-primary");
    submit.addEventListener("click", () => { void social.refresh(); });
    panel.appendChild(submit);
  }
  const reload = createButton("Ricarica pagina", "btn btn-secondary");
  reload.addEventListener("click", () => location.reload());
  panel.appendChild(reload);
  const logout = createButton("Esci", "btn btn-secondary");
  logout.id = "sign-out";
  logout.addEventListener("click", () => { void social.signOut(); });
  panel.appendChild(logout);
  container.replaceChildren(panel);

  function update() {
    const state = social.snapshot();
    const error = state.error || window.workoutLibrary.snapshot().error;
    status.textContent = error || state.notice || "";
    status.classList.toggle("error", Boolean(error));
    panel.setAttribute("aria-busy", String(screen === "loading" || state.busy));
    if (submit) {
      submit.disabled = state.busy;
      if (email) submit.textContent = state.busy
        ? creatingAccount ? "Registrazione in corso..." : "Accesso in corso..."
        : creatingAccount ? "Crea un account" : "Accedi";
    }
    if (email) email.disabled = state.busy;
    if (password) password.disabled = state.busy;
    if (toggle) toggle.disabled = state.busy;
    logout.hidden = !state.user;
    logout.disabled = Boolean(state.user && state.busy);
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
