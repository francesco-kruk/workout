function renderProfile(container) {
  const social = window.workoutSocial;
  const owner = social.snapshot().user?.id || null;
  let disposed = false;
  let submitting = false;
  container.replaceChildren(textEl("h2", "Profilo"));

  const account = document.createElement("section");
  account.className = "social-panel profile-account";
  const summary = document.createElement("div");
  summary.className = "profile-summary";
  const identity = document.createElement("div");
  const name = textEl("h3", "");
  const email = textEl("p", "", "view-description");
  identity.append(name, email);
  const logout = createButton("Esci", "btn btn-secondary");
  logout.id = "sign-out";
  logout.addEventListener("click", () => { void social.signOut(); });
  summary.append(identity, logout);
  account.appendChild(summary);
  const unavailable = textEl("p", "Le impostazioni account richiedono l'accesso al gruppo. I progressi locali restano disponibili.", "view-description");
  account.appendChild(unavailable);
  const forms = [];

  function field(form, labelText, name, type = "text", autocomplete = "") {
    const label = textEl("label", labelText);
    const input = document.createElement("input");
    input.name = name;
    input.type = type;
    input.required = true;
    input.autocomplete = autocomplete;
    label.appendChild(input);
    form.appendChild(label);
    return input;
  }

  function setting(title, kind, saveLabel) {
    const details = document.createElement("details");
    details.className = "profile-settings";
    details.appendChild(textEl("summary", title));
    const form = document.createElement("form");
    form.dataset.profileForm = kind;
    const status = textEl("p", "", "social-status profile-feedback");
    status.setAttribute("role", "status");
    const button = createButton(saveLabel, "btn btn-primary");
    button.type = "submit";
    details.appendChild(form);
    account.appendChild(details);
    const item = { details, form, status, button };
    forms.push(item);
    return item;
  }

  const display = setting("Nome visualizzato", "name", "Salva nome");
  const displayName = field(display.form, "Il tuo nome in classifica", "display-name", "text", "nickname");
  displayName.maxLength = 40;
  displayName.value = social.snapshot().member?.display_name || "";

  const address = setting("Modifica email", "email", "Salva email");
  const newEmail = field(address.form, "Nuova email", "email", "email", "email");
  const emailPassword = field(address.form, "Password attuale", "current-password", "password", "current-password");
  const pendingEmail = textEl("p", "", "view-description");
  address.details.insertBefore(pendingEmail, address.form);
  address.form.prepend(textEl("p", "La modifica può richiedere conferme via email. L'indirizzo attuale resta valido finché la modifica non è confermata.", "view-description"));

  const password = setting("Modifica password", "password", "Salva password");
  const currentPassword = field(password.form, "Password attuale", "current-password", "password", "current-password");
  const newPassword = field(password.form, "Nuova password", "new-password", "password", "new-password");
  newPassword.minLength = 8;
  const confirmation = field(password.form, "Conferma nuova password", "confirm-password", "password", "new-password");
  confirmation.minLength = 8;
  password.form.prepend(textEl("p", "Scegli una password di almeno 8 caratteri.", "view-description"));

  for (const item of forms) item.form.append(item.button, item.status);

  function clearPasswords() {
    for (const input of account.querySelectorAll('input[type="password"]')) input.value = "";
  }

  function feedback(item, result) {
    item.status.textContent = result.ok ? result.message : result.error;
    item.status.classList.toggle("error", !result.ok);
  }

  async function submit(item, operation) {
    if (disposed || submitting || social.snapshot().busy) return;
    item.status.textContent = "";
    item.details.open = true;
    if (!item.form.reportValidity()) {
      clearPasswords();
      return;
    }
    submitting = true;
    const request = operation();
    clearPasswords();
    update();
    try {
      const result = await request;
      if (disposed || social.snapshot().user?.id !== owner) return;
      feedback(item, result);
      if (result.ok && item === display) displayName.value = social.snapshot().member.display_name;
      if (result.ok && item === address) newEmail.value = "";
    } finally {
      submitting = false;
      clearPasswords();
      if (!disposed) update();
    }
  }

  display.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(display, () => social.saveName(displayName.value));
  });
  address.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(address, () => social.updateEmail(newEmail.value, emailPassword.value));
  });
  password.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (disposed || submitting || social.snapshot().busy) return;
    if (newPassword.value !== confirmation.value) {
      feedback(password, { ok: false, error: "Le nuove password non coincidono." });
      clearPasswords();
      return;
    }
    void submit(password, () => social.updatePassword(newPassword.value, currentPassword.value));
  });

  container.appendChild(account);
  const sound = document.createElement("section");
  sound.className = "social-panel";
  sound.appendChild(textEl("h3", "Suono del recupero"));
  const muteLabel = textEl("label", "Disattiva il suono del recupero");
  muteLabel.className = "tracking-weight";
  const mute = document.createElement("input");
  mute.type = "checkbox";
  mute.dataset.restSoundMuted = "";
  muteLabel.appendChild(mute);
  const soundStatus = textEl("p", "", "social-status");
  soundStatus.setAttribute("role", "status");
  sound.append(muteLabel,
    textEl("p", "Un breve segnale alla fine del recupero. Preferenza salvata solo su questo browser. In background o con lo schermo bloccato il browser potrebbe sospendere l'audio.", "view-description"),
    soundStatus);
  container.appendChild(sound);

  function updateSound() {
    try {
      mute.checked = window.workoutAudio.muted();
      mute.disabled = false;
      soundStatus.textContent = window.workoutAudio.error();
      soundStatus.classList.toggle("error", Boolean(soundStatus.textContent));
    } catch (failure) {
      console.error("Preferenza audio non leggibile.", failure);
      mute.disabled = true;
      soundStatus.textContent = `Preferenza audio non disponibile. ${failure.message}`;
      soundStatus.classList.add("error");
    }
  }
  mute.addEventListener("change", () => {
    try {
      window.workoutAudio.setMuted(mute.checked);
      soundStatus.textContent = mute.checked ? "Suono disattivato su questo browser." : "Suono attivato su questo browser.";
      if (!mute.checked) void window.workoutAudio.prepare();
    } catch (failure) {
      console.error("Preferenza audio non salvata.", failure);
      updateSound();
      soundStatus.textContent = `Preferenza audio non salvata. ${failure.message}`;
      soundStatus.classList.add("error");
    }
  });
  window.addEventListener("workout-audio-change", updateSound);
  window.addEventListener("storage", updateSound);
  updateSound();
  const progress = document.createElement("section");
  progress.className = "profile-progress";
  container.appendChild(progress);
  const cleanupProgress = renderProgress(progress, { embedded: true });

  function update() {
    const state = social.snapshot();
    if ((state.user?.id || null) !== owner) {
      clearPasswords();
      displayName.value = "";
      newEmail.value = "";
      account.hidden = true;
      return;
    }
    name.textContent = state.member?.display_name || "Account";
    email.textContent = state.user?.email || "";
    pendingEmail.textContent = state.user?.new_email
      ? `In attesa di conferma: ${state.user.new_email}. Controlla la posta e completa le conferme richieste.`
      : "";
    pendingEmail.hidden = !pendingEmail.textContent;
    const available = Boolean(state.user && state.member);
    unavailable.hidden = available;
    summary.hidden = !state.user;
    logout.disabled = state.busy || submitting;
    for (const item of forms) {
      item.details.hidden = !available;
      item.form.setAttribute("aria-busy", String(state.busy || submitting));
      for (const input of item.form.querySelectorAll("input, button")) input.disabled = state.busy || submitting;
    }
  }

  window.addEventListener("workout-social-change", update);
  update();
  return () => {
    disposed = true;
    clearPasswords();
    window.removeEventListener("workout-social-change", update);
    window.removeEventListener("workout-audio-change", updateSound);
    window.removeEventListener("storage", updateSound);
    cleanupProgress();
  };
}
