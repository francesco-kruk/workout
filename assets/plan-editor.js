function renderPersonalPlan(container) {
  const library = window.workoutLibrary;
  const ownerId = library.snapshot().userId;
  let active = true;
  let mode = "today";
  let inspectedDay = null;
  const expandedSections = new Map();
  let draft = null;
  let message = "";
  let saving = false;
  let status;
  let screen = "details";
  let selectedExercise = null;
  let pendingImport = null;
  let renderRevision = 0;
  let importRequest = 0;
  let hasError = false;
  try {
    draft = ownerId ? library.getDraft() : null;
  } catch (error) {
    console.error("Bozza non leggibile.", error);
    message = error.message;
  }

  function assertOwner() {
    if (!active || ownerId !== library.snapshot().userId) throw new Error("Account cambiato. Riapri la tua scheda.");
  }

  function showError(error) {
    console.error("Gestione scheda non riuscita.", error);
    message = error.message || String(error);
    hasError = true;
    if (status) {
      status.textContent = message;
      status.classList.add("error");
      status.focus();
    }
  }

  function persist() {
    assertOwner();
    draft = library.writeDraft(draft.definition, draft.baseVersionId);
    message = "Modifiche conservate sul telefono. Salva il piano per usarle.";
    hasError = false;
    if (status) {
      status.textContent = message;
      status.classList.remove("error");
    }
  }

  function begin(definition) {
    try {
      assertOwner();
      draft = library.writeDraft(definition);
      mode = "editor";
      screen = "details";
      selectedExercise = null;
      message = "";
      hasError = false;
      render();
    } catch (error) { showError(error); }
  }

  function button(label, action, className = "btn btn-secondary") {
    const element = createButton(label, className);
    element.addEventListener("click", action);
    return element;
  }

  function exportPlan(definition) {
    const url = URL.createObjectURL(new Blob([exportWorkoutCsv(definition)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "scheda-allenamento.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function render() {
    if (!active) return;
    renderRevision++;
    const state = library.snapshot();
    const member = window.workoutSocial.snapshot().member;
    container.replaceChildren();
    const toolbar = document.createElement("section");
    toolbar.className = "social-panel";
    toolbar.append(textEl("h2", state.plan?.title || "Il tuo piano"));
    status = textEl("p", message || state.error || state.notice || (state.loading ? "Caricamento scheda..." : ""), "social-status");
    status.setAttribute("role", "status");
    status.tabIndex = -1;
    status.classList.toggle("error", hasError || Boolean(state.error));
    toolbar.appendChild(status);
    container.appendChild(toolbar);

    if (!state.userId) {
      toolbar.appendChild(textEl("p", "Piano di esempio, in sola lettura. Per creare o modificare un piano personale devi accedere con un account approvato. In modalità locale puoi solo consultare l'esempio e allenarti; i progressi restano su questo browser.", "view-description"));
      if (state.plan) renderBrowsing(toolbar, state.plan);
      return;
    }
    if (!member) {
      toolbar.appendChild(textEl("p", "Accedi al gruppo e attendi l'approvazione prima di gestire la tua scheda.", "view-description"));
      return;
    }
    if (state.loading && !state.record) {
      toolbar.appendChild(textEl("p", "Caricamento della scheda personale...", "view-description"));
      return;
    }
    const actions = document.createElement("div");
    actions.className = "editor-actions";
    if (["editor", "create", "import-preview"].includes(mode)) {
      actions.appendChild(button("Torna al piano", () => { mode = "today"; render(); }));
    } else if (state.plan || draft) {
      actions.appendChild(button(draft ? "Riprendi modifica" : "Modifica piano", () => {
        if (!draft) begin(structuredClone(state.plan || newWorkoutPlan()));
        else { mode = "editor"; render(); }
      }, "btn btn-primary"));
      if (state.plan) {
        const create = button("Nuovo piano", () => { mode = "create"; render(); });
        create.disabled = Boolean(draft);
        actions.appendChild(create);
        if (draft) {
          toolbar.appendChild(textEl("p", "Hai modifiche non salvate. Riprendile o scarta la bozza in Altre opzioni prima di creare un nuovo piano.", "view-description"));
        }
      }
    }
    toolbar.appendChild(actions);
    if (state.plan && mode !== "editor") {
      toolbar.appendChild(button("Esporta CSV", () => exportPlan(state.plan)));
    }
    if (state.error) toolbar.appendChild(button("Riprova caricamento", () => { void library.load(); }));
    if (state.availableRecord) {
      toolbar.appendChild(textEl("p", "È disponibile un piano aggiornato. Puoi continuare l'allenamento attuale; usando quello nuovo inizierai progressi separati.", "view-description"));
      toolbar.appendChild(button("Usa piano aggiornato", () => {
        try { library.useLatest(); } catch (error) { showError(error); }
      }, "btn btn-primary"));
    }
    if (mode === "import-preview" && pendingImport) {
      renderImportPreview(toolbar);
    } else if (mode === "create") {
      renderCreation(toolbar);
    } else if (mode === "editor") {
      renderEditor();
    } else if (state.plan) {
      renderBrowsing(toolbar, state.plan);
    } else {
      renderCreation(toolbar);
    }
  }

  function downloadLink(label, path, filename) {
    const link = textEl("a", label, "btn btn-secondary");
    link.href = path;
    link.download = filename;
    return link;
  }

  function renderCreation(parent) {
    if (!library.snapshot().plan) parent.appendChild(textEl("p", "Non hai ancora una scheda personale.", "view-description"));
    parent.appendChild(textEl("p", "Scegli come creare la scheda. Il piano attuale non cambia finché non salvi.", "view-description"));
    const choices = document.createElement("div");
    choices.className = "creation-paths";
    const manual = document.createElement("section");
    manual.className = "overview-card";
    manual.append(textEl("h3", "Manualmente"), textEl("p", "Una giornata e un esercizio alla volta, poi rivedi e salva."));
    const start = button("Crea scheda", () => begin(newWorkoutPlan()), "btn btn-primary");
    start.disabled = Boolean(draft);
    manual.appendChild(start);
    const example = button("Personalizza esempio", () => {
      const template = library.template();
      if (template) begin({ ...template, trackingId: crypto.randomUUID() });
      else showError(new Error("Scheda di esempio non disponibile."));
    });
    example.disabled = Boolean(draft);
    manual.appendChild(example);
    choices.appendChild(manual);
    for (const agent of [false, true]) {
      const card = document.createElement("section");
      card.className = "overview-card";
      card.append(textEl("h3", agent ? "Con un agente" : "Modello CSV"),
        textEl("p", agent
          ? "Consegna modello e skill al tuo agente. Carica qui il CSV generato: controlli e salvi tu, senza condividere credenziali."
          : "Scarica il modello, modifica le righe in Excel o Google Sheets ed esporta come CSV UTF-8. Elimina gli esempi che non vuoi usare."));
      card.appendChild(downloadLink("Scarica modello CSV", "data/workout-plan-template.csv", "modello-allenamento.csv"));
      if (agent) {
        card.appendChild(downloadLink("Scarica skill", "assets/skills/workout-plan/SKILL.md", "SKILL.md"));
        card.appendChild(textEl("p", "Scaricare non installa la skill: allegala insieme al modello nella conversazione con il tuo agente.", "view-description"));
        const prompt = "Usa la skill workout-plan allegata e il modello CSV per creare la mia scheda. Chiedimi giornate, esercizi, obiettivi, serie, recuperi e tracciamento mancanti. Restituisci un CSV completo conforme al modello, senza accedere al mio account. Lo importerò, controllerò e salverò io nell'app.";
        const promptText = document.createElement("textarea");
        promptText.readOnly = true;
        promptText.value = prompt;
        promptText.setAttribute("aria-label", "Prompt per l'agente");
        card.append(promptText, button("Copia prompt", async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error("Copia automatica non disponibile. Seleziona e copia il testo del prompt.");
            await navigator.clipboard.writeText(prompt);
            assertOwner();
            message = "Prompt copiato.";
            status.textContent = message;
          } catch (error) { if (active) showError(error); }
        }));
      }
      renderImport(card);
      choices.appendChild(card);
    }
    parent.appendChild(choices);
    parent.appendChild(textEl("p", "Il CSV contiene righe plan, warmup, day ed exercise. Usa day_key per collegare gli esercizi alla giornata; standard = serie, amrap = circuito a tempo, reps = ripetizioni, seconds = secondi, true/false = sì/no. Non cambiare le intestazioni. Gli ID interni sono automatici.", "view-description"));
    const help = document.createElement("details");
    help.append(textEl("summary", "Istruzioni e limiti CSV"),
      textEl("p", "Una riga plan: format_version = 1 e name = titolo. Righe warmup facoltative: name, target, instructions. Righe day: day_key univoco, name, session_type e, per AMRAP, duration_minutes. Righe exercise: day_key della giornata, name e target. Lascia vuote le colonne non applicabili."),
      textEl("p", "Per esercizi standard: sets da 1 a 30, optional_sets da 0 a 30, rest_seconds obbligatorio da 0 a 3600 (0 = nessun recupero). measurement_mode: reps o seconds; uses_weight: true o false. Per AMRAP lascia vuoti serie e tracciamento; durata della giornata da 1 a 180 minuti."),
      textEl("p", "Da 1 a 30 giornate, da 1 a 50 esercizi ciascuna, da 0 a 50 riscaldamenti e massimo 1500 step per giornata. Testi fino a 4000 caratteri, piano convertito fino a 200000 caratteri e file fino a 800000 byte. I numeri devono essere interi senza unità; gli obiettivi possono essere testo libero."),
      textEl("p", "L'ordine delle righe stabilisce l'ordine di giornate ed esercizi. Salva come CSV UTF-8 con virgola o punto e virgola; usa virgolette per testi con separatori o a capo. Non usare formule: importa le colonne testuali come testo nel foglio di calcolo. L'esportazione protegge i testi simili a formule con un apostrofo, rimosso dall'app in importazione."));
    parent.appendChild(help);
    if (draft) parent.appendChild(textEl("p", "Hai una bozza: riprendila oppure importa un CSV e conferma esplicitamente la sostituzione.", "view-description"));
  }

  function renderImportPreview(parent) {
    const candidate = pendingImport;
    parent.append(textEl("h3", "Anteprima importazione"),
      textEl("p", `File: ${candidate.filename}. Controlla l'intera scheda prima di continuare. L'importazione sostituisce tutto il piano, non unisce esercizi.`),
      textEl("p", draft ? `Confermando sostituirai la bozza “${draft.definition.title}”. Il piano salvato rimane attivo fino al salvataggio.` : "Confermando creerai una bozza locale. Il piano salvato non cambia."));
    const preview = document.createElement("div");
    preview.className = "import-preview";
    preview.appendChild(textEl("h3", candidate.definition.title));
    renderPlan(preview.appendChild(document.createElement("div")), candidate.definition);
    parent.appendChild(preview);
    parent.append(
      button(draft ? "Sostituisci bozza con CSV" : "Usa CSV come bozza", () => {
        try {
          assertOwner();
          if ((library.getDraft()?.versionId || null) !== candidate.draftVersion) throw new Error("La bozza è cambiata. Importa di nuovo il CSV per non perdere le modifiche.");
          const errors = validateWorkoutPlan(candidate.definition);
          if (errors.length) throw new Error(errors.join("\n"));
          const definition = { ...candidate.definition, trackingId: crypto.randomUUID() };
          draft = library.writeDraft(definition, candidate.baseVersionId);
          pendingImport = null;
          screen = "review";
          mode = "editor";
          message = "CSV importato come bozza. Rivedi e salva per attivarlo; i confronti inizieranno da un nuovo storico.";
          render();
        } catch (error) { showError(error); }
      }, "btn btn-primary"),
      button("Annulla importazione", () => {
        try {
          assertOwner();
          draft = library.getDraft();
          pendingImport = null;
          mode = draft ? "editor" : "create";
          render();
        } catch (error) { showError(error); }
      })
    );
  }

  function renderBrowsing(toolbar, plan) {
    const controls = document.createElement("div");
    controls.className = "plan-switch";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Vista del piano");
    for (const [value, label] of [["today", "Oggi"], ["full", "Piano completo"]]) {
      const selected = mode === value;
      const control = button(label, () => { mode = value; inspectedDay = null; render(); }, selected ? "btn btn-primary" : "btn btn-secondary");
      control.setAttribute("aria-pressed", String(selected));
      controls.appendChild(control);
    }
    toolbar.appendChild(controls);
    const content = document.createElement("div");
    content.className = "plan-content";
    if (mode === "full") {
      renderPlan(content, plan, (id) => { inspectedDay = id; mode = "today"; render(); });
    } else {
      const selectedId = inspectedDay || getCurrentSessionId(plan);
      const label = textEl("label", "Consulta una giornata");
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Consulta una giornata");
      for (const day of plan.sessions) {
        const option = textEl("option", day.label);
        option.value = day.id;
        option.selected = day.id === selectedId;
        select.appendChild(option);
      }
      select.addEventListener("change", () => { inspectedDay = select.value; render(); });
      label.appendChild(select);
      toolbar.appendChild(label);
      if (selectedId !== getCurrentSessionId(plan)) {
        toolbar.appendChild(textEl("p", "Stai consultando un'altra giornata. L'allenamento attivo non cambia.", "view-description"));
        toolbar.appendChild(button("Torna a oggi", () => { inspectedDay = null; render(); }));
      }
      renderDay(content, plan, selectedId);
    }
    container.appendChild(content);
  }

  function editorSection(label, id, initiallyOpen = false) {
    const section = document.createElement("details");
    section.className = "editor-section";
    section.open = expandedSections.get(id) ?? initiallyOpen;
    section.appendChild(textEl("summary", label));
    section.addEventListener("toggle", () => expandedSections.set(id, section.open));
    return section;
  }

  function field(parent, label, model, key, { type = "text", min, max, required = false } = {}) {
    const wrapper = textEl("label", label);
    const input = document.createElement(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") input.type = type;
    input.value = model[key] ?? "";
    input.required = required;
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    if (type !== "number") input.maxLength = 4000;
    const error = textEl("span", "", "social-status error");
    if (!required) wrapper.appendChild(textEl("span", " (facoltativo)", "view-description"));
    error.id = `field-error-${crypto.randomUUID()}`;
    error.setAttribute("aria-live", "polite");
    input.setAttribute("aria-describedby", error.id);
    function validate() {
      if (type === "number") {
        error.textContent = validateNumberInput(input, label);
      } else {
        input.setCustomValidity(required && !input.value.trim() ? `${label}: campo obbligatorio.` : "");
        error.textContent = input.validationMessage;
        input.setAttribute("aria-invalid", String(!input.validity.valid));
      }
    }
    if (type === "number") {
      input.step = "1";
      input.inputMode = "numeric";
    }
    if (input.value) validate();
    input.addEventListener("invalid", validate);
    input.addEventListener("input", () => {
      validate();
      model[key] = type === "number"
        ? (input.value === "" ? (required || input.validity.badInput ? null : 0) : Number(input.value))
        : input.value;
      try { persist(); } catch (error) { showError(error); }
    });
    wrapper.appendChild(input);
    wrapper.appendChild(error);
    parent.appendChild(wrapper);
    return input;
  }

  function collectionControls(parent, items, index, min = 1) {
    const controls = document.createElement("div");
    controls.className = "editor-actions";
    const move = (offset) => {
      [items[index], items[index + offset]] = [items[index + offset], items[index]];
      try { persist(); render(); } catch (error) { showError(error); }
    };
    const up = button("Sposta su", () => move(-1));
    const down = button("Sposta giù", () => move(1));
    const remove = button("Rimuovi", () => {
      items.splice(index, 1);
      try { persist(); render(); } catch (error) { showError(error); }
    });
    up.disabled = index === 0;
    down.disabled = index === items.length - 1;
    remove.disabled = items.length <= min;
    controls.append(up, down, remove);
    parent.appendChild(controls);
  }

  function addTo(items, value) {
    items.push(value);
    expandedSections.set(value.id, true);
    try { persist(); render(); } catch (error) { showError(error); }
  }

  function renderImport(parent) {
    const label = textEl("label", "Carica scheda CSV");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.addEventListener("change", async () => {
      const request = ++importRequest;
      const revision = renderRevision;
      try {
        const file = input.files[0];
        if (!file) return;
        if (!file.name?.toLowerCase().endsWith(".csv")) throw new Error("Formato non supportato. Carica un file CSV UTF-8 usando il modello.");
        if (file.size > 800000) throw new Error("File troppo grande (massimo 800000 byte).");
        const draftVersion = library.getDraft()?.versionId || null;
        const baseVersionId = draft ? draft.baseVersionId : library.snapshot().record?.id ?? null;
        const source = await file.text();
        assertOwner();
        if (request !== importRequest || revision !== renderRevision) return;
        if ((library.getDraft()?.versionId || null) !== draftVersion) throw new Error("La bozza è cambiata durante la lettura. Carica di nuovo il CSV.");
        const definition = parseWorkoutCsv(source);
        pendingImport = { definition, filename: file.name, draftVersion, baseVersionId };
        mode = "import-preview";
        message = "";
        hasError = false;
        render();
        status.focus();
      } catch (error) {
        if (active && request === importRequest && revision === renderRevision) showError(error);
      } finally { input.value = ""; }
    });
    label.appendChild(input);
    parent.appendChild(label);
  }

  function renderEditor() {
    if (!draft) return;
    const definition = draft.definition;
    const form = document.createElement("form");
    form.className = "plan-editor social-panel";
    form.noValidate = true;
    const panels = [];
    function panel(value, title, exerciseId = null) {
      const section = document.createElement("section");
      section.className = "wizard-panel";
      section.dataset.screen = value;
      if (exerciseId) section.dataset.exercise = exerciseId;
      const heading = textEl("h3", title);
      heading.tabIndex = -1;
      section.appendChild(heading);
      panels.push(section);
      form.appendChild(section);
      return section;
    }
    function activate(value, exerciseId = null, focus = true) {
      if (focus) renderRevision++;
      screen = value;
      selectedExercise = exerciseId;
      for (const item of panels) {
        item.hidden = item.dataset.screen !== screen || (screen === "exercise" && item.dataset.exercise !== selectedExercise);
      }
      for (const control of navigation.querySelectorAll("button")) {
        control.setAttribute("aria-current", control.dataset.screen === (screen === "exercise" ? "days" : screen) ? "step" : "false");
      }
      for (const day of definition.sessions) {
        const group = form.querySelector(`[data-day="${day.id}"]`);
        if (group) group.querySelector("summary").textContent = `Giornata ${definition.sessions.indexOf(day) + 1} · ${day.label || "Nuova giornata"}`;
        for (const [index, exercise] of day.exercises.entries()) {
          const summary = form.querySelector(`[data-exercise-summary="${exercise.id}"]`);
          if (summary) {
            summary.querySelector("h4").textContent = `${index + 1}. ${exercise.name || "Nuovo esercizio"}`;
            summary.querySelector("p").textContent = exercise.target || "Obiettivo da compilare";
          }
          const exercisePanel = form.querySelector(`.wizard-panel[data-exercise="${exercise.id}"]`);
          if (exercisePanel) exercisePanel.querySelector("h3").textContent = `${day.label || `Giornata ${definition.sessions.indexOf(day) + 1}`} · Esercizio ${index + 1} di ${day.exercises.length}`;
        }
      }
      if (focus) panels.find((item) => !item.hidden)?.querySelector("h3")?.focus();
    }
    function checkFields(onlyVisible = false) {
      const invalid = [...form.querySelectorAll("input, select, textarea")]
        .find((input) => (!onlyVisible || !input.closest(".wizard-panel")?.hidden) && !input.validity.valid);
      if (!invalid) return true;
      const section = invalid.closest(".wizard-panel");
      if (section) activate(section.dataset.screen, section.dataset.exercise);
      let parent = invalid.parentElement;
      while (parent && parent !== form) {
        if (parent.tagName === "DETAILS") parent.open = true;
        parent = parent.parentElement;
      }
      invalid.reportValidity();
      invalid.focus();
      return false;
    }
    function review() {
      if (!checkFields()) return;
      const errors = validateWorkoutPlan(definition);
      if (errors.length) { showError(new Error(errors.join("\n"))); return; }
      renderPlan(reviewContent, definition, (id) => {
        activate("days");
        const day = form.querySelector(`[data-day="${id}"]`);
        if (day) { day.open = true; day.querySelector("input")?.focus(); }
      }, (id) => activate("exercise", id));
      activate("review");
    }
    const navigation = document.createElement("nav");
    navigation.className = "editor-actions wizard-navigation";
    navigation.setAttribute("aria-label", "Passaggi della scheda");
    for (const [value, label] of [["details", "1. Dettagli"], ["days", "2. Giornate"], ["review", "3. Rivedi piano"]]) {
      const control = button(label, () => value === "review" ? review() : activate(value));
      control.dataset.screen = value;
      navigation.appendChild(control);
    }
    form.appendChild(navigation);
    form.appendChild(textEl("p", "Le modifiche restano sul telefono finché non salvi il piano. Il piano attuale resta disponibile fino al salvataggio. Salvare un piano nuovo o modificato avvia progressi separati; gli allenamenti precedenti restano in Profilo.", "view-description"));
    form.addEventListener("invalid", (event) => {
      let section = event.target.parentElement;
      while (section && section !== form) {
        if (section.tagName === "DETAILS") section.open = true;
        section = section.parentElement;
      }
    }, true);
    const detailsPanel = panel("details", "Dettagli della scheda");
    field(detailsPanel, "Titolo della scheda", definition, "title", { required: true });
    const options = editorSection("Altre opzioni", "options");
    const transfers = document.createElement("div");
    transfers.className = "editor-actions";
    transfers.append(
      button("Esporta CSV della bozza", () => exportPlan(definition)),
      button("Scarta bozza e ricarica", async () => {
        try {
          assertOwner();
          library.discardDraft();
          draft = null;
          mode = "today";
          message = "";
          render();
          await library.load();
        } catch (error) { showError(error); }
      })
    );
    renderImport(options);
    options.appendChild(textEl("p", "Un'esportazione della bozza può contenere campi incompleti: correggili prima di importarla.", "view-description"));
    options.appendChild(transfers);
    detailsPanel.appendChild(options);
    const warmup = editorSection("Riscaldamento comune", "warmup");
    warmup.appendChild(textEl("p", "Facoltativo e comune a tutte le giornate. Aggiungi gli esercizi che vuoi includere oppure lascia il riscaldamento vuoto.", "view-description"));
    definition.warmup.forEach((item, index) => {
      const group = document.createElement("fieldset");
      group.appendChild(textEl("legend", `Riscaldamento ${index + 1}`));
      field(group, "Nome", item, "name", { required: true });
      field(group, "Obiettivo", item, "target", { required: true });
      field(group, "Istruzioni", item, "instructions", { type: "textarea" });
      collectionControls(group, definition.warmup, index, 0);
      warmup.appendChild(group);
    });
    const addWarmup = button("Aggiungi riscaldamento", () => addTo(definition.warmup, newWorkoutItem()));
    addWarmup.disabled = definition.warmup.length >= 50;
    warmup.appendChild(addWarmup);
    detailsPanel.appendChild(warmup);
    detailsPanel.appendChild(button("Continua alle giornate", () => { if (checkFields(true)) activate("days"); }, "btn btn-primary"));
    const daysPanel = panel("days", "Giornate ed esercizi");
    definition.sessions.forEach((day, dayIndex) => {
      const group = editorSection(`Giornata ${dayIndex + 1} · ${day.label || "Nuova giornata"}`, day.id, true);
      group.classList.add("editor-day");
      group.dataset.day = day.id;
      field(group, "Nome giornata", day, "label", { required: true });
      const dayOptions = editorSection("Dettagli facoltativi della giornata", `options-${day.id}`);
      field(dayOptions, "Sottotitolo", day, "subtitle");
      const typeLabel = textEl("label", "Tipo di allenamento");
      const type = document.createElement("select");
      for (const [value, label] of [["standard", "Serie"], ["amrap", "AMRAP"]]) {
        const option = textEl("option", label);
        option.value = value;
        option.selected = value === day.type;
        type.appendChild(option);
      }
      type.addEventListener("change", () => {
        day.type = type.value;
        if (day.type === "amrap") day.duration ||= "20 minuti";
        else for (const item of day.exercises) {
          if (item.sets === undefined) item.sets = 3;
          if (item.optionalSets === undefined) item.optionalSets = 0;
        }
        try { persist(); render(); } catch (error) { showError(error); }
      });
      typeLabel.appendChild(type);
      group.appendChild(typeLabel);
      if (day.type === "amrap") {
        const duration = field(group, "Durata (es. 20 minuti)", day, "duration", { required: true });
        duration.pattern = "(?:[1-9]|[1-9][0-9]|1[0-7][0-9]|180)(?: (?:min|minuti))?";
      }
      field(dayOptions, "Istruzioni della giornata", day, "instructions", { type: "textarea" });
      group.appendChild(dayOptions);
      day.exercises.forEach((exercise, exerciseIndex) => {
        const summary = document.createElement("article");
        summary.className = "readonly-item";
        summary.dataset.exerciseSummary = exercise.id;
        summary.append(textEl("h4", `${exerciseIndex + 1}. ${exercise.name || "Nuovo esercizio"}`),
          textEl("p", exercise.target || "Obiettivo da compilare", "view-description"),
          button("Modifica esercizio", () => activate("exercise", exercise.id)));
        collectionControls(summary, day.exercises, exerciseIndex);
        group.appendChild(summary);
        const exerciseGroup = panel("exercise", `${day.label || `Giornata ${dayIndex + 1}`} · Esercizio ${exerciseIndex + 1} di ${day.exercises.length}`, exercise.id);
        exerciseGroup.classList.add("editor-section");
        field(exerciseGroup, "Nome esercizio", exercise, "name", { required: true });
        field(exerciseGroup, "Obiettivo / ripetizioni", exercise, "target", { required: true });
        if (day.type === "standard") {
          const tracking = getExerciseTracking(exercise);
          const modeLabel = textEl("label", "Tracciamento");
          const mode = document.createElement("select");
          for (const [value, label] of [["reps", "Ripetizioni"], ["seconds", "Durata (secondi)"]]) {
            const option = textEl("option", label);
            option.value = value;
            option.selected = tracking.mode === value;
            mode.appendChild(option);
          }
          mode.addEventListener("change", () => {
            exercise.measurementMode = mode.value;
            try { persist(); } catch (error) { showError(error); }
          });
          modeLabel.appendChild(mode);
          const weightLabel = textEl("label", "Prevede un peso");
          weightLabel.className = "tracking-weight";
          const weight = document.createElement("input");
          weight.type = "checkbox";
          weight.checked = tracking.usesWeight;
          weight.addEventListener("change", () => {
            exercise.usesWeight = weight.checked;
            try { persist(); } catch (error) { showError(error); }
          });
          weightLabel.appendChild(weight);
          exerciseGroup.append(modeLabel, weightLabel);
          field(exerciseGroup, "Serie obbligatorie", exercise, "sets", { type: "number", min: 1, max: 30, required: true });
          field(exerciseGroup, "Recupero (secondi)", exercise, "rest", { type: "number", min: 0, max: 3600, required: true });
          exerciseGroup.appendChild(textEl("p", "Inserisci 0 per nessun recupero.", "view-description"));
        }
        const exerciseOptions = editorSection("Dettagli facoltativi dell'esercizio", `options-${exercise.id}`);
        if (day.type === "standard") field(exerciseOptions, "Serie opzionali", exercise, "optionalSets", { type: "number", min: 0, max: 30 });
        field(exerciseOptions, "Istruzioni esercizio", exercise, "instructions", { type: "textarea" });
        exerciseGroup.appendChild(exerciseOptions);
        const exerciseActions = document.createElement("div");
        exerciseActions.className = "editor-actions";
        exerciseActions.appendChild(button("Torna alle giornate", () => activate("days")));
        exerciseActions.appendChild(button(exerciseIndex + 1 < day.exercises.length ? "Esercizio successivo" : "Completa giornata", () => {
          if (checkFields(true)) activate(exerciseIndex + 1 < day.exercises.length ? "exercise" : "days", day.exercises[exerciseIndex + 1]?.id);
        }, "btn btn-primary"));
        exerciseGroup.appendChild(exerciseActions);
      });
      const addExercise = button("Aggiungi esercizio", () => {
        const exercise = newWorkoutExercise();
        selectedExercise = exercise.id;
        screen = "exercise";
        addTo(day.exercises, exercise);
      });
      addExercise.disabled = day.exercises.length >= 50;
      group.appendChild(addExercise);
      collectionControls(group, definition.sessions, dayIndex);
      daysPanel.appendChild(group);
    });
    const addDay = button("Aggiungi giornata", () => addTo(definition.sessions, newWorkoutDay()));
    addDay.disabled = definition.sessions.length >= 30;
    daysPanel.append(addDay, button("Rivedi e continua", review, "btn btn-primary"));
    const reviewPanel = panel("review", "Rivedi e salva");
    reviewPanel.appendChild(textEl("p", "Salvare attiva questa scheda e avvia progressi separati. Lo storico degli allenamenti precedenti resta in Profilo.", "view-description"));
    const reviewContent = document.createElement("div");
    reviewPanel.appendChild(reviewContent);
    renderPlan(reviewContent, definition, (id) => {
      activate("days");
      const day = form.querySelector(`[data-day="${id}"]`);
      if (day) { day.open = true; day.querySelector("input")?.focus(); }
    }, (id) => activate("exercise", id));
    const submit = createButton(saving ? "Salvataggio..." : "Salva piano", "btn btn-primary");
    submit.type = "submit";
    submit.disabled = saving;
    reviewPanel.appendChild(submit);
    if (screen === "exercise" && !definition.sessions.some((day) => day.exercises.some((exercise) => exercise.id === selectedExercise))) screen = "days";
    activate(screen, selectedExercise, false);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      if (!checkFields()) return;
      const errors = validateWorkoutPlan(draft.definition);
      if (errors.length) {
        showError(new Error(errors.join("\n")));
        return;
      }
      if (screen !== "review") { review(); return; }
      saving = true;
      for (const input of container.querySelectorAll("button, input, select, textarea")) input.disabled = true;
      try {
        assertOwner();
        await library.save(draft);
        if (!active) return;
        saving = false;
        draft = null;
        mode = "today";
        message = "Piano salvato.";
        render();
      } catch (error) {
        if (active) {
          showError(error);
          saving = false;
          render();
        }
      }
    });
    container.appendChild(form);
    if (hasError) status.focus();
    else panels.find((item) => !item.hidden)?.querySelector("h3")?.focus();
  }

  function onStatus() {
    if (mode !== "editor" || !container.querySelector(".plan-editor")) render();
    else if (status) status.textContent = message || library.snapshot().error;
  }
  window.addEventListener("workout-library-status", onStatus);
  render();
  return () => {
    active = false;
    window.removeEventListener("workout-library-status", onStatus);
  };
}

function newWorkoutItem() {
  return { id: `item-${crypto.randomUUID()}`, name: "", target: "", instructions: "" };
}
function newWorkoutExercise() {
  return { ...newWorkoutItem(), measurementMode: "reps", usesWeight: false, sets: 3, optionalSets: 0 };
}
function newWorkoutDay() {
  return { id: `day-${crypto.randomUUID()}`, label: "", type: "standard", instructions: "", exercises: [newWorkoutExercise()] };
}
function newWorkoutPlan() {
  return { version: 2, trackingId: crypto.randomUUID(), title: "La mia scheda", warmup: [], sessions: [newWorkoutDay()] };
}
