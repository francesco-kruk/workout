function renderPersonalPlan(container) {
  const library = window.workoutLibrary;
  const ownerId = library.snapshot().userId;
  let active = true;
  let mode = "overview";
  let draft = null;
  let message = "";
  let saving = false;
  let status;
  try {
    draft = ownerId ? library.getDraft() : null;
    if (draft) mode = "editor";
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
    if (status) status.textContent = message;
  }

  function persist() {
    assertOwner();
    draft = library.writeDraft(draft.definition, draft.baseVersionId);
    message = "Bozza salvata su questo dispositivo. Pubblica online per usarla.";
    if (status) status.textContent = message;
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
    toolbar.append(textEl("h2", state.userId ? "La mia scheda" : "Scheda di esempio"));
    status = textEl("p", message || state.error || state.notice || (state.loading ? "Caricamento scheda..." : ""), "social-status");
    status.setAttribute("role", "status");
    toolbar.appendChild(status);
    container.appendChild(toolbar);

    if (!state.userId) {
      toolbar.appendChild(textEl("p", "Questa è una scheda di esempio, con progressi solo su questo browser. Accedi dalla Classifica per creare la tua scheda privata.", "view-description"));
      if (state.plan) {
        const overview = document.createElement("div");
        renderPlan(overview, state.plan);
        container.appendChild(overview);
      }
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
    actions.append(
      button("Scheda", () => { mode = "overview"; render(); }),
      button("Modifica / crea", () => {
        if (!draft) begin(structuredClone(state.plan || newWorkoutPlan()));
        else { mode = "editor"; render(); }
      }),
      button("Storico", () => { mode = "history"; render(); void library.loadHistory(); }),
      button("Aggiorna dal server", () => { void library.load(); })
    );
    toolbar.appendChild(actions);
    if (state.availableRecord) {
      toolbar.appendChild(button("Usa versione aggiornata (progressi separati)", () => {
        try { library.useLatest(); } catch (error) { showError(error); }
      }, "btn btn-primary"));
    }
    if (mode === "editor") {
      renderEditor();
    } else if (mode === "history") {
      renderHistory();
    } else if (state.plan) {
      toolbar.appendChild(textEl("p", `Versione ${state.record.revision}. I progressi attivi restano su questo dispositivo; ogni modifica pubblicata crea una nuova versione.`, "view-description"));
      const overview = document.createElement("div");
      renderPlan(overview, state.plan);
      container.appendChild(overview);
    } else {
      toolbar.appendChild(textEl("p", "Non hai ancora una scheda personale. Creala da zero, importa un file JSON o personalizza l'esempio.", "view-description"));
      toolbar.append(
        button("Crea scheda", () => begin(newWorkoutPlan()), "btn btn-primary"),
        button("Personalizza esempio", () => {
          const template = library.template();
          if (template) begin(template);
          else showError(new Error("Scheda di esempio non disponibile."));
        })
      );
      renderImport(toolbar);
    }
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
    input.addEventListener("input", () => {
      model[key] = type === "number" ? (input.value === "" ? (required ? null : 0) : Number(input.value)) : input.value;
      try { persist(); } catch (error) { showError(error); }
    });
    wrapper.appendChild(input);
    parent.appendChild(wrapper);
    return input;
  }

  function collectionControls(parent, items, index) {
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
    remove.disabled = items.length === 1;
    controls.append(up, down, remove);
    parent.appendChild(controls);
  }

  function addTo(items, value) {
    items.push(value);
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
        begin(definition);
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
    form.appendChild(textEl("p", "Le bozze restano locali. Pubblicare avvia progressi separati per la nuova versione; i risultati storici non cambiano.", "view-description"));
    field(form, "Titolo della scheda", definition, "title", { required: true });
    const transfers = document.createElement("div");
    transfers.className = "editor-actions";
    transfers.append(
      button("Esporta JSON", () => exportPlan(definition)),
      button("Scarta bozza e ricarica", async () => {
        try {
          assertOwner();
          library.discardDraft();
          draft = null;
          mode = "overview";
          message = "";
          render();
          await library.load();
        } catch (error) { showError(error); }
      })
    );
    renderImport(form);
    form.appendChild(transfers);
    form.appendChild(textEl("h3", "Riscaldamento comune"));
    definition.warmup.forEach((item, index) => {
      const group = document.createElement("fieldset");
      group.appendChild(textEl("legend", `Riscaldamento ${index + 1}`));
      field(group, "Nome", item, "name", { required: true });
      field(group, "Obiettivo", item, "target", { required: true });
      field(group, "Istruzioni", item, "instructions", { type: "textarea" });
      collectionControls(group, definition.warmup, index);
      form.appendChild(group);
    });
    const addWarmup = button("Aggiungi riscaldamento", () => addTo(definition.warmup, newWorkoutItem()));
    addWarmup.disabled = definition.warmup.length >= 50;
    form.appendChild(addWarmup);
    definition.sessions.forEach((day, dayIndex) => {
      const group = document.createElement("fieldset");
      group.className = "editor-day";
      group.appendChild(textEl("legend", `Giornata ${dayIndex + 1}`));
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
        const exerciseGroup = document.createElement("fieldset");
        exerciseGroup.appendChild(textEl("legend", `Esercizio ${exerciseIndex + 1}`));
        field(exerciseGroup, "Nome esercizio", exercise, "name", { required: true });
        field(exerciseGroup, "Obiettivo / ripetizioni", exercise, "target", { required: true });
        if (day.type === "standard") {
          field(exerciseGroup, "Serie obbligatorie", exercise, "sets", { type: "number", min: 1, max: 30, required: true });
          field(exerciseGroup, "Serie opzionali", exercise, "optionalSets", { type: "number", min: 0, max: 30 });
          field(exerciseGroup, "Recupero in secondi (es. 60-90 secondi)", exercise, "rest");
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
    const submit = createButton(saving ? "Pubblicazione..." : "Pubblica scheda", "btn btn-primary");
    submit.type = "submit";
    submit.disabled = saving;
    form.append(addDay, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      for (const input of form.querySelectorAll("button, input, select, textarea")) input.disabled = true;
      try {
        assertOwner();
        await library.save(draft);
        if (!active) return;
        saving = false;
        draft = null;
        mode = "overview";
        message = "Scheda pubblicata.";
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

  function renderHistory() {
    const state = library.snapshot();
    const section = document.createElement("section");
    section.className = "social-panel";
    section.append(
      textEl("h3", "Storico privato"),
      textEl("p", "Solo tu puoi leggere questi dettagli. Registriamo gli step completati o saltati e i giri AMRAP, non pesi o ripetizioni effettive non inseriti nell'app.", "view-description")
    );
    let pending = [];
    try {
      pending = state.userId ? pendingAttendance(state.userId).filter((receipt) => receipt.workout) : [];
    } catch (error) { showError(error); }
    if (pending.length) section.appendChild(textEl("p", `${pending.length} allenamenti locali in attesa di invio.`, "view-description"));
    if (state.historyLoading) section.appendChild(textEl("p", "Caricamento storico..."));
    if (!state.history.length && !state.historyLoading) section.appendChild(textEl("p", "Nessun allenamento sincronizzato."));
    for (const result of state.history) {
      const details = document.createElement("details");
      const date = new Date(result.completed_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" });
      details.appendChild(textEl("summary", `${date} · ${result.session.label} · ${result.plan_title} (v${result.revision})`));
      const list = document.createElement("ul");
      const historicalPlan = { warmup: result.warmup, sessions: [result.session] };
      for (const step of getWorkoutSteps(historicalPlan, result.session)) {
        const label = step.type === "warmup" ? step.item.name
          : step.type === "amrap" ? `AMRAP: ${result.amrap_rounds} giri`
            : `${step.exercise.name}, serie ${step.setNumber} · ${step.exercise.target}`;
        list.appendChild(textEl("li", `${label}: ${result.steps[step.key] === "completed" ? "Fatto" : "Saltato"}`));
      }
      details.appendChild(list);
      section.appendChild(details);
    }
    if (state.moreHistory) {
      const more = button("Carica precedenti", () => { void library.loadHistory(true); });
      more.disabled = state.historyLoading;
      section.appendChild(more);
    }
    section.appendChild(button("Aggiorna storico", () => { void library.loadHistory(); }));
    container.appendChild(section);
  }

  function onStatus() {
    if (mode === "overview" || (mode === "editor" && !container.querySelector(".plan-editor"))) render();
    else if (status) status.textContent = message || library.snapshot().error;
  }
  function onHistory() { if (mode === "history") render(); }
  window.addEventListener("workout-library-status", onStatus);
  window.addEventListener("workout-history-change", onHistory);
  render();
  return () => {
    active = false;
    window.removeEventListener("workout-library-status", onStatus);
    window.removeEventListener("workout-history-change", onHistory);
  };
}

function newWorkoutItem() {
  return { id: `item-${crypto.randomUUID()}`, name: "", target: "", instructions: "" };
}
function newWorkoutExercise() {
  return { ...newWorkoutItem(), sets: 3, optionalSets: 0, rest: "" };
}
function newWorkoutDay() {
  return { id: `day-${crypto.randomUUID()}`, label: "", type: "standard", instructions: "", exercises: [newWorkoutExercise()] };
}
function newWorkoutPlan() {
  return { version: 2, title: "La mia scheda", warmup: [newWorkoutItem()], sessions: [newWorkoutDay()] };
}
