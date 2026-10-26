function renderPersonalPlan(container) {
  const library = window.workoutLibrary;
  const ownerId = library.snapshot().userId;
  let active = true;
  let mode = "today";
  let operation = "create";
  let baseRecord = null;
  let inspectedDay = null;
  let draft = null;
  let screen = "details";
  let selectedDay = null;
  let selectedExercise = null;
  let message = "";
  let hasError = false;
  let saving = false;
  let status;
  let generation = 0;
  let importRequest = 0;
  let importedFile = "";
  let preservesIdentity = false;
  let back = () => choose(operation);
  const expandedSections = new Map();

  function assertOwner() {
    if (!active || ownerId !== library.snapshot().userId) throw new Error("Account cambiato. Riapri il piano.");
  }

  function showError(error) {
    console.error("Gestione piano non riuscita.", error);
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
    message = "";
    hasError = false;
    if (status) { status.textContent = ""; status.classList.remove("error"); }
  }

  function discard() {
    generation++;
    importRequest++;
    draft = null;
    baseRecord = null;
    importedFile = "";
    message = "";
    hasError = false;
    library.discardDraft();
  }

  function cancel() {
    if (saving) return;
    discard();
    mode = "today";
    render();
  }

  function choose(intent) {
    if (saving) return;
    discard();
    operation = intent;
    mode = "choose";
    render();
  }

  function start(method) {
    try {
      assertOwner();
      discard();
      baseRecord = structuredClone(library.snapshot().record);
      mode = method;
      screen = "details";
      selectedExercise = null;
      if (method === "manual") {
        draft = library.writeDraft(operation === "edit" ? structuredClone(baseRecord.definition) : newWorkoutPlan(), baseRecord?.id || null);
        selectedDay = draft.definition.sessions[0].id;
      }
      render();
    } catch (error) { showError(error); }
  }

  function button(label, action, className = "btn btn-secondary") {
    const element = createButton(label, className);
    element.addEventListener("click", action);
    return element;
  }

  function exportPlan(definition, sourceVersionId = null) {
    try {
      const csv = exportWorkoutCsv(definition, { sourceVersionId });
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "scheda-allenamento.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showError(error); }
  }

  async function save() {
    if (saving || !draft) return;
    try {
      assertOwner();
      const errors = validateWorkoutPlan(draft.definition);
      if (errors.length) throw new Error(errors.join("\n"));
      saving = true;
      for (const input of container.querySelectorAll("button, input, select, textarea")) input.disabled = true;
      window.dispatchEvent(new CustomEvent("workout-plan-saving", { detail: true }));
      await library.save(draft);
      if (active) {
        draft = null;
        mode = "today";
        message = "Piano salvato.";
      }
    } catch (error) {
      if (active) {
        showError(error);
        message += " Le modifiche restano solo qui: non chiudere la schermata. Se l'esito è incerto, verifica il piano prima di riprovare.";
      }
    } finally {
      saving = false;
      window.dispatchEvent(new CustomEvent("workout-plan-saving", { detail: false }));
      if (active) render();
    }
  }

  function render() {
    if (!active) return;
    const state = library.snapshot();
    const member = window.workoutSocial.snapshot().member;
    container.replaceChildren();
    const toolbar = document.createElement("section");
    toolbar.className = "social-panel";
    toolbar.append(textEl("h2", state.plan?.title || "Il tuo piano"));
    status = textEl("p", message || state.error || state.notice || "", "social-status");
    status.setAttribute("role", "status");
    status.tabIndex = -1;
    status.classList.toggle("error", hasError || Boolean(state.error));
    toolbar.appendChild(status);
    container.appendChild(toolbar);
    if (!state.userId) {
      toolbar.appendChild(textEl("p", "Piano di esempio, in sola lettura. Per creare o modificare un piano personale accedi con un account approvato.", "view-description"));
      if (state.plan) renderBrowsing(toolbar, state.plan);
      return;
    }
    if (!member) {
      toolbar.appendChild(textEl("p", "Accedi al gruppo e attendi l'approvazione prima di gestire il piano.", "view-description"));
      return;
    }
    if (state.loading && !state.record) {
      toolbar.appendChild(textEl("p", "Caricamento del piano personale...", "view-description"));
      return;
    }
    const editing = ["choose", "manual", "csv", "csv-review"].includes(mode);
    container.classList.toggle("authoring-active", editing);
    if (editing) {
      const controls = document.createElement("div");
      controls.className = "editor-actions authoring-controls";
      controls.append(
        button("Indietro", () => { if (!saving) back(); }),
        button("Annulla", cancel)
      );
      toolbar.append(controls, textEl("p", "Le modifiche restano solo in questa schermata. Annullare, cambiare tab o ricaricare le scarta. Solo Salva piano le conferma.", "view-description"));
    } else {
      const actions = document.createElement("div");
      actions.className = "editor-actions";
      if (state.plan) {
        actions.append(
          button("Modifica piano", () => choose("edit"), "btn btn-primary"),
          button("Nuovo piano", () => choose("create")),
          button("Esporta CSV", () => exportPlan(state.plan, state.record.id))
        );
      }
      toolbar.appendChild(actions);
      if (state.error) toolbar.appendChild(button("Riprova caricamento", () => { void library.load(); }));
      if (state.availableRecord) {
        toolbar.append(textEl("p", "È disponibile un piano aggiornato. Usandolo inizierai progressi separati.", "view-description"),
          button("Usa piano aggiornato", () => {
            try { library.useLatest(); } catch (error) { showError(error); }
          }, "btn btn-primary"));
      }
      renderLegacyRecovery(toolbar);
    }
    if (mode === "choose" || (!state.plan && !editing)) renderChoices(toolbar);
    else if (mode === "manual") renderEditor();
    else if (mode === "csv" || mode === "csv-review") renderCsv(toolbar);
    else if (state.plan) renderBrowsing(toolbar, state.plan);
    if (hasError) status.focus();
  }

  function renderChoices(parent) {
    back = cancel;
    if (!library.snapshot().plan) parent.appendChild(textEl("p", "Non hai ancora una scheda personale.", "view-description"));
    parent.append(textEl("h3", operation === "edit" ? "Come vuoi modificare il piano?" : "Come vuoi creare il piano?"),
      textEl("p", "Scegli un metodo per iniziare. Il piano salvato non cambia fino alla conferma.", "view-description"));
    const choices = document.createElement("div");
    choices.className = "creation-paths";
    for (const [method, title, description] of [
      ["manual", "Manuale", "Un passaggio alla volta: titolo, giornate ed esercizi. Poi rivedi e salva."],
      ["csv", "CSV", operation === "edit" ? "Esporta il piano, modifica più righe in un foglio di calcolo e reimportalo." : "Scarica il modello, compila le righe e importa il piano."]
    ]) {
      const card = document.createElement("section");
      card.className = "overview-card";
      card.append(textEl("h3", title), textEl("p", description),
        button(method === "manual" ? "Usa Manuale" : "Usa CSV", () => start(method), "btn btn-primary"));
      choices.appendChild(card);
    }
    parent.appendChild(choices);
  }

  function renderLegacyRecovery(parent) {
    let legacy;
    const removeLegacy = () => {
      try { assertOwner(); library.discardLegacyDraft(); message = ""; hasError = false; render(); } catch (error) { showError(error); }
    };
    try { legacy = library.getLegacyDraft(); } catch (error) {
      showError(error);
      parent.appendChild(button("Elimina vecchia bozza non leggibile", removeLegacy));
      return;
    }
    if (!legacy) return;
    const recovery = document.createElement("details");
    recovery.className = "editor-section";
    recovery.append(textEl("summary", "Recupera una vecchia bozza"),
      textEl("p", "Questa bozza proviene dalla versione precedente. Non viene ripresa né eliminata automaticamente. Esportala in CSV per recuperarla; i nuovi lavori non vengono conservati quando esci."),
      button("Esporta vecchia bozza", () => exportPlan(legacy.definition)),
      button("Elimina vecchia bozza", removeLegacy));
    parent.appendChild(recovery);
  }

  function renderCsv(parent) {
    back = mode === "csv-review" ? () => { mode = "csv"; render(); } : () => choose(operation);
    if (mode === "csv-review" && draft) {
      parent.append(textEl("h3", "Rivedi il CSV"),
        textEl("p", `File: ${importedFile}. L'importazione sostituisce l'intero piano, non unisce le righe.`),
        textEl("p", preservesIdentity
          ? "Le identità sono conservate: gli esercizi compatibili mantengono i confronti con lo storico."
          : "Questo piano inizia nuovi confronti. Per mantenere lo storico, modifica un'esportazione del piano attuale senza cambiare i metadati."),
        textEl("p", "Salvare attiva il piano e avvia progressi separati. Gli allenamenti precedenti restano in Progresso.", "view-description"));
      const preview = document.createElement("div");
      preview.className = "import-preview";
      preview.appendChild(textEl("h3", draft.definition.title));
      renderPlan(preview.appendChild(document.createElement("div")), draft.definition);
      parent.append(preview,
        button("Salva piano", () => { void save(); }, "btn btn-primary"),
        button("Esporta CSV delle modifiche", () => exportPlan(draft.definition, preservesIdentity ? baseRecord?.id : null)));
      return;
    }
    parent.append(textEl("h3", "CSV: esporta, modifica, importa"),
      textEl("p", "1. Scarica il piano o il modello. 2. Modifica le righe in Excel o Google Sheets ed esporta come CSV UTF-8. 3. Carica il file, rivedi e salva."));
    if (operation === "edit") {
      parent.appendChild(button("Esporta piano da modificare", () => exportPlan(baseRecord.definition, baseRecord.id), "btn btn-primary"));
    } else {
      const link = textEl("a", "Scarica modello CSV", "btn btn-primary");
      link.href = "data/workout-plan-template.csv";
      link.download = "modello-allenamento.csv";
      parent.appendChild(link);
    }
    const label = textEl("label", "Carica scheda CSV");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.addEventListener("change", async () => {
      const request = ++importRequest;
      const flow = generation;
      const previousDraft = draft?.versionId;
      try {
        const file = input.files[0];
        if (!file) return;
        if (!file.name?.toLowerCase().endsWith(".csv")) throw new Error("Formato non supportato. Carica un file CSV UTF-8 usando il modello.");
        if (file.size > 800000) throw new Error("File troppo grande (massimo 800000 byte).");
        const source = await file.text();
        if (!active || request !== importRequest || flow !== generation || mode !== "csv") return;
        assertOwner();
        if (previousDraft !== library.getDraft()?.versionId) throw new Error("Le modifiche sono cambiate durante la lettura. Carica di nuovo il CSV.");
        const candidate = readWorkoutCsv(source, { baseRecord: operation === "edit" ? baseRecord : null });
        draft = library.writeDraft(candidate.definition, baseRecord?.id || null);
        importedFile = file.name;
        preservesIdentity = candidate.preservesIdentity;
        mode = "csv-review";
        message = "";
        hasError = false;
        render();
      } catch (error) {
        if (active && request === importRequest && flow === generation) showError(error);
      } finally { input.value = ""; }
    });
    label.appendChild(input);
    parent.appendChild(label);
    if (draft) parent.appendChild(button("Rivedi CSV caricato", () => { importRequest++; mode = "csv-review"; render(); }));
    const help = document.createElement("details");
    help.append(textEl("summary", "Istruzioni e limiti CSV"),
      textEl("p", "Righe plan, warmup, day ed exercise. day_key collega gli esercizi alla giornata; l'ordine delle righe stabilisce l'ordine degli elementi. Non cambiare le intestazioni."),
      textEl("p", "Per mantenere i confronti durante una modifica, non cambiare source_version_id, tracking_id e row_id. Lascia row_id vuoto per un nuovo elemento, anche quando copi una riga. Un vecchio CSV senza metadati inizia nuovi confronti."),
      textEl("p", "Standard: sets da 1 a 30, optional_sets da 0 a 30, rest_seconds obbligatorio da 0 a 3600 (0 = nessun recupero); measurement_mode reps/seconds e uses_weight true/false. AMRAP: duration_minutes da 1 a 180; lascia vuoti serie e tracciamento individuali."),
      textEl("p", "Da 1 a 30 giornate, da 1 a 50 esercizi per giornata, da 0 a 50 riscaldamenti; massimo 1500 step per giornata, 4000 caratteri per testo, 200000 per piano, 1600 righe e 800000 byte per file."),
      textEl("p", "CSV UTF-8 con virgola o punto e virgola. Usa virgolette per separatori e a capo. Importa le colonne testuali come testo, non formule; l'apostrofo protettivo dell'esportazione viene rimosso in importazione."));
    parent.appendChild(help);
  }

  function renderBrowsing(toolbar, plan) {
    const controls = document.createElement("div");
    controls.className = "plan-switch";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Vista del piano");
    for (const [value, label] of [["today", "Oggi"], ["full", "Piano completo"]]) {
      const control = button(label, () => { mode = value; inspectedDay = null; render(); }, mode === value ? "btn btn-primary" : "btn btn-secondary");
      control.setAttribute("aria-pressed", String(mode === value));
      controls.appendChild(control);
    }
    toolbar.appendChild(controls);
    const content = document.createElement("div");
    content.className = "plan-content";
    if (mode === "full") renderPlan(content, plan, (id) => { inspectedDay = id; mode = "today"; render(); });
    else {
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
        toolbar.append(textEl("p", "Stai consultando un'altra giornata. L'allenamento attivo non cambia.", "view-description"),
          button("Torna a oggi", () => { inspectedDay = null; render(); }));
      }
      renderDay(content, plan, selectedId);
    }
    container.appendChild(content);
  }

  function editorSection(label, id) {
    const section = document.createElement("details");
    section.className = "editor-section";
    section.open = expandedSections.get(id) || false;
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
      if (type === "number") error.textContent = validateNumberInput(input, label);
      else {
        input.setCustomValidity(required && !input.value.trim() ? `${label}: campo obbligatorio.` : "");
        error.textContent = input.validationMessage;
        input.setAttribute("aria-invalid", String(!input.validity.valid));
      }
    }
    if (type === "number") { input.step = "1"; input.inputMode = "numeric"; }
    if (input.value) validate();
    input.addEventListener("invalid", validate);
    input.addEventListener("input", () => {
      validate();
      model[key] = type === "number" ? (input.value === "" ? (required || input.validity.badInput ? null : 0) : Number(input.value)) : input.value;
      try { persist(); } catch (error) { showError(error); }
    });
    wrapper.append(input, error);
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

  function renderEditor() {
    if (!draft) return;
    const definition = draft.definition;
    const form = document.createElement("form");
    form.className = "plan-editor social-panel";
    form.noValidate = true;
    const panels = [];
    function panel(value, title, id = "") {
      const section = document.createElement("section");
      section.className = "wizard-panel";
      section.dataset.screen = value;
      section.dataset.item = id;
      const heading = textEl("h3", title);
      heading.tabIndex = -1;
      section.appendChild(heading);
      panels.push(section);
      form.appendChild(section);
      return section;
    }
    function activate(value, id = "", focus = true) {
      screen = value;
      if (value === "day") selectedDay = id || selectedDay;
      if (value === "exercise") {
        selectedExercise = id || selectedExercise;
        selectedDay = definition.sessions.find((day) => day.exercises.some((item) => item.id === selectedExercise))?.id;
      }
      for (const item of panels) {
        item.hidden = item.dataset.screen !== screen
          || (screen === "day" && item.dataset.item !== selectedDay)
          || (screen === "exercise" && item.dataset.item !== selectedExercise);
      }
      for (const control of navigation.querySelectorAll("button")) {
        control.setAttribute("aria-current", control.dataset.screen === (["day", "exercise"].includes(screen) ? "days" : screen) ? "step" : "false");
      }
      for (const day of definition.sessions) {
        const summary = form.querySelector(`[data-day="${day.id}"]`);
        if (summary) summary.querySelector("h4").textContent = day.label || "Nuova giornata";
        for (const exercise of day.exercises) {
          const summary = form.querySelector(`[data-exercise-summary="${exercise.id}"]`);
          if (summary) {
            summary.querySelector("h4").textContent = exercise.name || "Nuovo esercizio";
            summary.querySelector("p").textContent = exercise.target || "Obiettivo da compilare";
          }
        }
      }
      if (focus) panels.find((item) => !item.hidden)?.querySelector("h3")?.focus();
    }
    function checkFields(onlyVisible = false) {
      const invalid = [...form.querySelectorAll("input, select, textarea")]
        .find((input) => (!onlyVisible || !input.closest(".wizard-panel")?.hidden) && !input.validity.valid);
      if (!invalid) return true;
      const section = invalid.closest(".wizard-panel");
      if (section) activate(section.dataset.screen, section.dataset.item);
      for (let parent = invalid.parentElement; parent && parent !== form; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS") parent.open = true;
      }
      invalid.reportValidity();
      invalid.focus();
      return false;
    }
    function review() {
      if (!checkFields()) return;
      const errors = validateWorkoutPlan(definition);
      if (errors.length) { showError(new Error(errors.join("\n"))); return; }
      renderReview();
      activate("review");
    }
    function add(items, item, next, id = item.id) {
      items.push(item);
      try { persist(); screen = next; if (next === "day") selectedDay = id; if (next === "exercise") selectedExercise = id; render(); } catch (error) { showError(error); }
    }
    back = () => {
      if (screen === "details") choose(operation);
      else if (screen === "exercise") activate("day", selectedDay);
      else if (screen === "day") activate(operation === "create" && definition.sessions.length === 1 ? "details" : "days");
      else if (screen === "review") activate("days");
      else activate("details");
    };
    const navigation = document.createElement("nav");
    navigation.className = "editor-actions wizard-navigation";
    navigation.setAttribute("aria-label", "Passaggi del piano");
    for (const [value, label] of [["details", "1. Dettagli"], ["days", "2. Giornate"], ["review", "3. Rivedi piano"]]) {
      const control = button(label, () => value === "review" ? review() : activate(value));
      control.dataset.screen = value;
      navigation.appendChild(control);
    }
    form.appendChild(navigation);
    const details = panel("details", "Il titolo del piano");
    field(details, "Titolo della scheda", definition, "title", { required: true });
    if (operation === "create") details.appendChild(button("Personalizza esempio", () => {
      const template = library.template();
      if (!template) { showError(new Error("Piano di esempio non disponibile.")); return; }
      draft = library.writeDraft({ ...template, trackingId: crypto.randomUUID() }, baseRecord?.id || null);
      selectedDay = draft.definition.sessions[0].id;
      render();
    }));
    const warmup = editorSection("Riscaldamento comune (facoltativo)", "warmup");
    warmup.appendChild(textEl("p", "Comune a tutte le giornate. Puoi lasciare il riscaldamento vuoto.", "view-description"));
    definition.warmup.forEach((item, index) => {
      const group = document.createElement("fieldset");
      group.appendChild(textEl("legend", `Riscaldamento ${index + 1}`));
      field(group, "Nome", item, "name", { required: true });
      field(group, "Obiettivo", item, "target", { required: true });
      field(group, "Istruzioni", item, "instructions", { type: "textarea" });
      collectionControls(group, definition.warmup, index, 0);
      warmup.appendChild(group);
    });
    const addWarmup = button("Aggiungi riscaldamento", () => {
      expandedSections.set("warmup", true);
      add(definition.warmup, newWorkoutItem(), "details");
    });
    addWarmup.disabled = definition.warmup.length >= 50;
    warmup.appendChild(addWarmup);
    details.append(warmup, button("Continua alle giornate", () => {
      if (checkFields(true)) activate("day", selectedDay || definition.sessions[0].id);
    }, "btn btn-primary"));
    const days = panel("days", "Giornate ed esercizi");
    definition.sessions.forEach((day, dayIndex) => {
      const overview = document.createElement("section");
      overview.className = "overview-card editor-day";
      overview.dataset.day = day.id;
      overview.append(textEl("h4", day.label || "Nuova giornata"), button("Modifica giornata", () => activate("day", day.id)));
      for (const [index, exercise] of day.exercises.entries()) {
        const summary = document.createElement("article");
        summary.className = "readonly-item";
        summary.dataset.exerciseSummary = exercise.id;
        summary.append(textEl("h4", exercise.name || "Nuovo esercizio"), textEl("p", exercise.target || "Obiettivo da compilare"),
          button("Modifica esercizio", () => activate("exercise", exercise.id)));
        collectionControls(summary, day.exercises, index);
        overview.appendChild(summary);
      }
      collectionControls(overview, definition.sessions, dayIndex);
      days.appendChild(overview);
      const dayPanel = panel("day", `Giornata ${dayIndex + 1} di ${definition.sessions.length}`, day.id);
      field(dayPanel, "Nome giornata", day, "label", { required: true });
      const typeLabel = textEl("label", "Tipo di allenamento");
      const type = document.createElement("select");
      for (const [value, label] of [["standard", "Serie"], ["amrap", "AMRAP"]]) {
        const option = textEl("option", label);
        option.value = value;
        option.selected = day.type === value;
        type.appendChild(option);
      }
      type.addEventListener("change", () => {
        day.type = type.value;
        if (day.type === "amrap") day.duration ||= "20 minuti";
        else for (const item of day.exercises) {
          item.sets ??= 3;
          item.optionalSets ??= 0;
        }
        try { persist(); screen = "day"; selectedDay = day.id; render(); } catch (error) { showError(error); }
      });
      typeLabel.appendChild(type);
      dayPanel.appendChild(typeLabel);
      if (day.type === "amrap") {
        const duration = field(dayPanel, "Durata (es. 20 minuti)", day, "duration", { required: true });
        duration.pattern = "(?:[1-9]|[1-9][0-9]|1[0-7][0-9]|180)(?: (?:min|minuti))?";
      }
      const options = editorSection("Dettagli facoltativi della giornata", `day-${day.id}`);
      field(options, "Sottotitolo", day, "subtitle");
      field(options, "Istruzioni della giornata", day, "instructions", { type: "textarea" });
      dayPanel.append(options, button("Continua agli esercizi", () => {
        if (checkFields(true)) activate("exercise", day.exercises[0].id);
      }, "btn btn-primary"));
      for (const [index, exercise] of day.exercises.entries()) {
        const exercisePanel = panel("exercise", `Giornata ${dayIndex + 1} · Esercizio ${index + 1} di ${day.exercises.length}`, exercise.id);
        exercisePanel.dataset.exercise = exercise.id;
        field(exercisePanel, "Nome esercizio", exercise, "name", { required: true });
        field(exercisePanel, "Obiettivo / ripetizioni", exercise, "target", { required: true });
        if (day.type === "standard") {
          field(exercisePanel, "Serie obbligatorie", exercise, "sets", { type: "number", min: 1, max: 30, required: true });
          field(exercisePanel, "Recupero (secondi)", exercise, "rest", { type: "number", min: 0, max: 3600, required: true });
          exercisePanel.appendChild(textEl("p", "Inserisci 0 per nessun recupero.", "view-description"));
          const tracking = getExerciseTracking(exercise);
          const modeLabel = textEl("label", "Tracciamento");
          const select = document.createElement("select");
          for (const [value, label] of [["reps", "Ripetizioni"], ["seconds", "Durata (secondi)"]]) {
            const option = textEl("option", label);
            option.value = value;
            option.selected = tracking.mode === value;
            select.appendChild(option);
          }
          select.addEventListener("change", () => {
            exercise.measurementMode = select.value;
            try { persist(); } catch (error) { showError(error); }
          });
          modeLabel.appendChild(select);
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
          exercisePanel.append(modeLabel, weightLabel);
        }
        const options = editorSection("Dettagli facoltativi dell'esercizio", `exercise-${exercise.id}`);
        if (day.type === "standard") field(options, "Serie opzionali", exercise, "optionalSets", { type: "number", min: 0, max: 30 });
        field(options, "Istruzioni esercizio", exercise, "instructions", { type: "textarea" });
        exercisePanel.appendChild(options);
        exercisePanel.appendChild(button(index + 1 < day.exercises.length ? "Esercizio successivo" : "Completa giornata", () => {
          if (checkFields(true)) activate(index + 1 < day.exercises.length ? "exercise" : "days", day.exercises[index + 1]?.id);
        }, "btn btn-primary"));
        const more = button("Aggiungi esercizio", () => {
          if (checkFields(true)) add(day.exercises, newWorkoutExercise(), "exercise");
        });
        more.disabled = day.exercises.length >= 50;
        exercisePanel.appendChild(more);
      }
    });
    const addDay = button("Aggiungi giornata", () => add(definition.sessions, newWorkoutDay(), "day"));
    addDay.disabled = definition.sessions.length >= 30;
    days.append(addDay, button("Rivedi e continua", review, "btn btn-primary"));
    const reviewPanel = panel("review", "Rivedi e salva");
    reviewPanel.appendChild(textEl("p", "Salvare attiva il piano e avvia progressi separati. Gli allenamenti precedenti restano in Progresso.", "view-description"));
    const reviewContent = document.createElement("div");
    function renderReview() {
      renderPlan(reviewContent, definition, (id) => activate("day", id), (id) => activate("exercise", id));
    }
    renderReview();
    const submit = createButton(saving ? "Salvataggio..." : "Salva piano", "btn btn-primary");
    submit.type = "submit";
    reviewPanel.append(reviewContent, submit, button("Esporta CSV delle modifiche", () => exportPlan(definition)));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (saving || !checkFields()) return;
      if (screen !== "review") { review(); return; }
      void save();
    });
    if (screen === "day" && !definition.sessions.some((day) => day.id === selectedDay)) screen = "days";
    if (screen === "exercise" && !definition.sessions.some((day) => day.exercises.some((item) => item.id === selectedExercise))) screen = "days";
    activate(screen, screen === "exercise" ? selectedExercise : selectedDay, false);
    container.appendChild(form);
    panels.find((item) => !item.hidden)?.querySelector("h3")?.focus();
  }

  function onStatus() {
    if (["today", "full", "choose"].includes(mode)) render();
    else if (status) status.textContent = message || library.snapshot().error;
  }
  function onPageHide() {
    if (!saving && ["choose", "manual", "csv", "csv-review"].includes(mode)) cancel();
  }
  window.addEventListener("workout-library-status", onStatus);
  window.addEventListener("pagehide", onPageHide);
  render();
  return () => {
    active = false;
    generation++;
    importRequest++;
    if (draft && ownerId === library.snapshot().userId && library.getDraft()?.versionId === draft.versionId) library.discardDraft();
    draft = null;
    baseRecord = null;
    container.classList.remove("authoring-active");
    window.removeEventListener("workout-library-status", onStatus);
    window.removeEventListener("pagehide", onPageHide);
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
