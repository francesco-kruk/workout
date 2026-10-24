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
      message = "";
      render();
    } catch (error) { showError(error); }
  }

  function button(label, action, className = "btn btn-secondary") {
    const element = createButton(label, className);
    element.addEventListener("click", action);
    return element;
  }

  function exportPlan(definition) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "scheda-allenamento.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function render() {
    if (!active) return;
    const state = library.snapshot();
    const member = window.workoutSocial.snapshot().member;
    container.replaceChildren();
    const toolbar = document.createElement("section");
    toolbar.className = "social-panel";
    toolbar.append(textEl("h2", state.plan?.title || "Il tuo piano"));
    status = textEl("p", message || state.error || state.notice || (state.loading ? "Caricamento scheda..." : ""), "social-status");
    status.setAttribute("role", "status");
    status.tabIndex = -1;
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
    if (mode === "editor") {
      actions.appendChild(button("Torna al piano", () => { mode = "today"; render(); }));
    } else if (state.plan || draft) {
      actions.appendChild(button(draft ? "Riprendi modifica" : "Modifica piano", () => {
        if (!draft) begin(structuredClone(state.plan || newWorkoutPlan()));
        else { mode = "editor"; render(); }
      }, "btn btn-primary"));
      if (state.plan) {
        const create = button("Nuovo piano", () => begin(newWorkoutPlan()));
        create.disabled = Boolean(draft);
        actions.appendChild(create);
        if (draft) {
          toolbar.appendChild(textEl("p", "Hai modifiche non salvate. Riprendile o scarta la bozza in Altre opzioni prima di creare un nuovo piano.", "view-description"));
        }
      }
    }
    toolbar.appendChild(actions);
    if (state.error) toolbar.appendChild(button("Riprova caricamento", () => { void library.load(); }));
    if (state.availableRecord) {
      toolbar.appendChild(textEl("p", "È disponibile un piano aggiornato. Puoi continuare l'allenamento attuale; usando quello nuovo inizierai progressi separati.", "view-description"));
      toolbar.appendChild(button("Usa piano aggiornato", () => {
        try { library.useLatest(); } catch (error) { showError(error); }
      }, "btn btn-primary"));
    }
    if (mode === "editor") {
      renderEditor();
    } else if (state.plan) {
      renderBrowsing(toolbar, state.plan);
    } else {
      toolbar.appendChild(textEl("p", "Non hai ancora una scheda personale. Creala da zero, importa un file JSON o personalizza l'esempio.", "view-description"));
      toolbar.append(
        button("Crea scheda", () => begin(newWorkoutPlan()), "btn btn-primary"),
        button("Personalizza esempio", () => {
          const template = library.template();
          if (template) begin({ ...template, trackingId: crypto.randomUUID() });
          else showError(new Error("Scheda di esempio non disponibile."));
        })
      );
      const options = document.createElement("details");
      options.appendChild(textEl("summary", "Importa un piano JSON"));
      renderImport(options);
      toolbar.appendChild(options);
    }
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
    const label = textEl("label", "Importa scheda JSON (formato versione 2)");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      try {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 800000) throw new Error("File troppo grande.");
        const definition = JSON.parse(await file.text());
        assertOwner();
        const errors = validateWorkoutPlan(definition);
        if (errors.length) throw new Error(errors.join("\n"));
        begin({ ...definition, trackingId: crypto.randomUUID() });
      } catch (error) { if (active) showError(error); }
    });
    label.appendChild(input);
    parent.appendChild(label);
  }

  function renderEditor() {
    if (!draft) return;
    const definition = draft.definition;
    const form = document.createElement("form");
    form.className = "plan-editor social-panel";
    form.appendChild(textEl("p", "Le modifiche restano sul telefono finché non salvi il piano. Il piano attuale resta disponibile fino al salvataggio. Salvare un piano nuovo o modificato avvia progressi separati; gli allenamenti precedenti restano in Profilo.", "view-description"));
    form.addEventListener("invalid", (event) => {
      let section = event.target.parentElement;
      while (section && section !== form) {
        if (section.tagName === "DETAILS") section.open = true;
        section = section.parentElement;
      }
    }, true);
    field(form, "Titolo della scheda", definition, "title", { required: true });
    const options = editorSection("Altre opzioni", "options");
    const transfers = document.createElement("div");
    transfers.className = "editor-actions";
    transfers.append(
      button("Esporta JSON", () => exportPlan(definition)),
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
    options.appendChild(transfers);
    form.appendChild(options);
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
    form.appendChild(warmup);
    definition.sessions.forEach((day, dayIndex) => {
      const group = editorSection(`Giornata ${dayIndex + 1} · ${day.label || "Nuova giornata"}`, day.id);
      group.classList.add("editor-day");
      field(group, "Nome giornata", day, "label", { required: true });
      field(group, "Sottotitolo", day, "subtitle");
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
        else for (const item of day.exercises) { item.sets ||= 3; item.optionalSets ||= 0; }
        try { persist(); render(); } catch (error) { showError(error); }
      });
      typeLabel.appendChild(type);
      group.appendChild(typeLabel);
      if (day.type === "amrap") field(group, "Durata (es. 20 minuti)", day, "duration", { required: true });
      field(group, "Istruzioni della giornata", day, "instructions", { type: "textarea" });
      day.exercises.forEach((exercise, exerciseIndex) => {
        const exerciseGroup = editorSection(`Esercizio ${exerciseIndex + 1} · ${exercise.name || "Nuovo esercizio"}`, exercise.id);
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
          field(exerciseGroup, "Serie opzionali", exercise, "optionalSets", { type: "number", min: 0, max: 30 });
          field(exerciseGroup, "Recupero (secondi)", exercise, "rest", { type: "number", min: 0, max: 3600, required: true });
          exerciseGroup.appendChild(textEl("p", "Inserisci 0 per nessun recupero.", "view-description"));
        }
        field(exerciseGroup, "Istruzioni esercizio", exercise, "instructions", { type: "textarea" });
        collectionControls(exerciseGroup, day.exercises, exerciseIndex);
        group.appendChild(exerciseGroup);
      });
      const addExercise = button("Aggiungi esercizio", () => addTo(day.exercises, newWorkoutExercise()));
      addExercise.disabled = day.exercises.length >= 50;
      group.appendChild(addExercise);
      collectionControls(group, definition.sessions, dayIndex);
      form.appendChild(group);
    });
    const addDay = button("Aggiungi giornata", () => addTo(definition.sessions, newWorkoutDay()));
    addDay.disabled = definition.sessions.length >= 30;
    const submit = createButton(saving ? "Salvataggio..." : "Salva piano", "btn btn-primary");
    submit.type = "submit";
    submit.disabled = saving;
    form.append(addDay, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      if (!form.reportValidity()) return;
      const errors = validateWorkoutPlan(draft.definition);
      if (errors.length) {
        for (const section of form.querySelectorAll("details")) section.open = true;
        showError(new Error(errors.join("\n")));
        return;
      }
      saving = true;
      for (const input of form.querySelectorAll("button, input, select, textarea")) input.disabled = true;
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
