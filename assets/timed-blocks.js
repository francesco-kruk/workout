function renderTimedBlock(step, { refresh, complete, back, previous, onActivity = () => {} }) {
  const sessionId = step.session.id;
  const block = step.block || {
    id: sessionId, type: "amrap", label: step.session.subtitle || step.session.label,
    instructions: step.session.instructions, exercises: step.session.exercises,
    durationMinutes: parseDurationSeconds(step.session.duration) / 60,
  };
  const legacy = !step.block;
  const locked = hasRecordedWorkout(getProgress(sessionId).runId);
  const read = () => {
    if (!legacy) return getBlockProgress(sessionId, block);
    const value = getProgress(sessionId).amrap;
    return { ...value, timer: value.remainingMilliseconds === null ? null
      : { remainingMilliseconds: value.remainingMilliseconds, deadline: value.deadline } };
  };
  const save = (updates) => {
    if (locked) throw new Error("Allenamento già salvato, in sola lettura.");
    if (legacy) {
      const { timer, ...values } = updates;
      updateAmrap(sessionId, { ...values, ...(timer !== undefined ? {
        remainingMilliseconds: timer?.remainingMilliseconds ?? null, deadline: timer?.deadline ?? null,
      } : {}) });
    } else updateBlockProgress(sessionId, block.id, updates);
    onActivity();
  };
  const card = document.createElement("article");
  card.className = `focus-card ${block.type}-focus`;
  card.append(textEl("p", `Circuito ${workoutBlockLabel(block)}`, "focus-kicker"),
    textEl("h3", block.label), textEl("p", block.instructions || "", "focus-instructions"));
  const error = textEl("p", "", "social-status error");
  error.dataset.measurementError = "";
  error.setAttribute("role", "alert");
  const guard = (action, clear = true) => {
    try { action(); if (clear) error.textContent = ""; } catch (failure) {
      console.error("Blocco a tempo non aggiornato.", failure);
      error.textContent = failure.message;
    }
  };
  const prescription = document.createElement("div");
  card.appendChild(prescription);
  const clockPanel = document.createElement("div");
  clockPanel.className = `${block.type}-timer`;
  const display = textEl("strong", "", "timer-value");
  const clockStatus = textEl("span", "", "timer-status");
  clockStatus.setAttribute("role", "status");
  clockPanel.append(display, clockStatus);
  card.appendChild(clockPanel);
  const controls = document.createElement("div");
  controls.className = "timer-controls";
  const toggle = createButton("Avvia timer", "btn btn-primary");
  const reset = createButton("Reset", "btn btn-secondary");
  const actions = document.createElement("div");
  actions.className = "workout-actions";
  const finish = createButton(`Completa ${workoutBlockLabel(block)}`, "btn btn-primary");
  let selectedMinute = null;
  let shownMinute = null;
  let started = false;
  let disposed = false;
  let interval = null;
  const content = document.createElement("div");
  const fields = [];
  card.appendChild(content);

  function listExercises(exercises, parent) {
    const list = document.createElement("ol");
    list.className = "amrap-focus-list";
    for (const exercise of exercises) {
      const item = document.createElement("li");
      item.append(textEl("strong", exercise.name), textEl("span", exercise.target));
      if (exercise.instructions) item.appendChild(textEl("p", exercise.instructions, "exercise-instructions"));
      list.appendChild(item);
    }
    parent.appendChild(list);
  }

  if (block.type === "amrap") {
    listExercises(block.exercises, prescription);
    const roundsControl = document.createElement("div");
    roundsControl.className = "rounds-control";
    const rounds = textEl("strong", String(read().rounds || 0), "rounds-value");
    const minus = createButton("−", "btn btn-icon");
    minus.setAttribute("aria-label", "Rimuovi un giro");
    const plus = createButton("+", "btn btn-icon");
    plus.setAttribute("aria-label", "Aggiungi un giro");
    function change(delta) {
      guard(() => {
        const next = parseAmrapCount((read().rounds || 0) + delta, "Giri completi");
        save({ rounds: next });
        rounds.textContent = String(next);
        minus.disabled = locked || next === 0;
        plus.disabled = locked || next === 100000;
      });
    }
    minus.disabled = locked || !read().rounds;
    plus.disabled = locked || read().rounds >= 100000;
    minus.addEventListener("click", () => change(-1));
    plus.addEventListener("click", () => change(1));
    roundsControl.append(minus, rounds, textEl("span", "giri completi"), plus);
    const label = textEl("label", "Ripetizioni extra (facoltative)");
    const extra = document.createElement("input");
    Object.assign(extra, { type: "number", min: "0", max: "100000", step: "1", inputMode: "numeric", value: read().extraReps ?? "", disabled: locked });
    extra.dataset.actualField = "extraReps";
    extra.addEventListener("input", () => guard(() => {
      save({ extraReps: extra.validity.badInput ? "invalid" : extra.value });
      const message = validateNumberInput(extra, "Ripetizioni extra");
      paint();
      if (message) throw new Error(message);
    }));
    fields.push(extra);
    label.appendChild(extra);
    content.append(roundsControl, label, textEl("p", "Totale delle ripetizioni dopo l'ultimo giro completo.", "view-description"));
  }
  previous?.(card, sessionId, null, null, step.block?.id);

  function renderMinute(clock) {
    const index = selectedMinute ?? clock.minute;
    const value = read();
    const entry = value.minutes?.[index] || {};
    const slot = block.minutes[index % block.minutes.length];
    prescription.replaceChildren(textEl("p", `Giro ${Math.floor(clock.minute / block.minutes.length) + 1} di ${block.rounds} · minuto ${clock.minute + 1} di ${block.rounds * block.minutes.length}`, "focus-kicker"));
    listExercises(block.minutes[clock.minute % block.minutes.length].exercises, prescription);
    const next = clock.minute + 1;
    if (next < block.rounds * block.minutes.length) prescription.appendChild(textEl("p",
      `Prossimo minuto: ${block.minutes[next % block.minutes.length].exercises.map((e) => e.name).join(" + ")}`, "view-description"));
    content.replaceChildren();
    const label = textEl("label", "Rivedi minuto EMOM");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Rivedi minuto EMOM");
    for (let i = 0; i <= clock.minute; i++) {
      const option = textEl("option", `Minuto ${i + 1} · ${value.minutes?.[i]?.status === "completed" ? "Fatto" : value.minutes?.[i]?.status === "missed" ? "Mancato" : "Da confermare"}`);
      option.value = String(i);
      option.selected = i === index;
      select.appendChild(option);
    }
    select.disabled = !value.timer;
    select.addEventListener("change", () => { selectedMinute = Number(select.value); shownMinute = null; paint(); });
    label.appendChild(select);
    const confirmed = Object.values(value.minutes || {}).filter((minute) => ["completed", "missed"].includes(minute.status)).length;
    content.append(textEl("p", `${confirmed} di ${block.rounds * block.minutes.length} minuti confermati. Il tempo trascorso non conferma il lavoro.`, "view-description"),
      label, textEl("h4", `Risultato minuto ${index + 1}`));
    if (selectedMinute !== null) {
      const follow = createButton("Segui minuto attuale", "btn btn-secondary");
      follow.addEventListener("click", () => { selectedMinute = null; shownMinute = null; paint(); });
      content.appendChild(follow);
    }
    const status = document.createElement("div");
    status.className = "editor-actions";
    function updateMinute(updates) {
      const current = read();
      save({ minutes: { ...current.minutes, [index]: { ...current.minutes?.[index], ...updates } } });
    }
    for (const [key, caption] of [["completed", "Minuto completato"], ["missed", "Minuto mancato"]]) {
      const button = createButton(caption, entry.status === key ? "btn btn-primary" : "btn btn-secondary");
      button.disabled = locked || !value.timer;
      button.addEventListener("click", () => guard(() => {
        updateMinute({ status: key, ...(key === "missed" ? { measurements: {} } : {}) });
        shownMinute = null;
        paint();
      }));
      status.appendChild(button);
    }
    content.appendChild(status);
    if (index !== clock.minute) listExercises(slot.exercises, content);
    for (const exercise of slot.exercises) {
      const details = document.createElement("details");
      details.className = "emom-measurements";
      details.appendChild(textEl("summary", `${exercise.name}: risultati facoltativi`));
      const { mode, usesWeight } = getExerciseTracking(exercise);
      for (const [key, caption, max, increment] of [
        [mode, mode === "seconds" ? "Durata (secondi)" : "Ripetizioni", mode === "seconds" ? 86400 : 100000, "1"],
        ...(usesWeight ? [["weightKg", "Peso (kg)", 2000, "0.01"]] : []),
        ["notes", "Note", 1000, ""],
      ]) {
        const wrapper = textEl("label", caption);
        const input = document.createElement("input");
        input.type = key === "notes" ? "text" : "number";
        if (key === "notes") input.maxLength = 1000;
        else { input.min = "0"; input.max = String(max); input.step = increment; }
        input.value = entry.measurements?.[exercise.id]?.[key] ?? "";
        input.disabled = locked || entry.status !== "completed";
        input.addEventListener("input", () => guard(() => {
          const current = read().minutes[index];
          const raw = { ...current.measurements?.[exercise.id], [key]: input.validity.badInput ? "invalid" : input.value };
          updateMinute({ measurements: { ...current.measurements, [exercise.id]: raw } });
          parseSetResult(raw, exercise);
          if (!input.checkValidity()) throw new Error(`${caption}: valore non valido.`);
        }));
        wrapper.appendChild(input);
        details.appendChild(wrapper);
      }
      content.appendChild(details);
    }
    if (clock.remaining === 0) content.appendChild(textEl("p",
      "Tempo terminato. Conferma ogni minuto come completato o mancato prima di finire.", "view-description"));
  }

  function paint() {
    if (disposed) return;
    const value = read();
    const clock = timedBlockClock(block, value);
    if (clock.running && interval === null) interval = window.setInterval(() => guard(paint, false), 250);
    else if (!clock.running && interval !== null) { window.clearInterval(interval); interval = null; }
    started = Boolean(value.timer);
    display.textContent = formatTime(Math.ceil((block.type === "emom" && clock.remaining > 0
      ? 60000 - clock.elapsed % 60000 : clock.remaining) / 1000));
    clockStatus.textContent = clock.remaining === 0 ? "Tempo terminato" : clock.running ? "Timer in corso"
      : started ? "Timer in pausa" : "Timer pronto";
    if (block.type === "emom" && value.minutes?.[clock.minute]?.status === "completed" && clock.remaining > 0) {
      clockStatus.textContent += " · Recupero fino al prossimo minuto";
    }
    toggle.textContent = clock.remaining === 0 ? "Tempo terminato" : clock.running ? "Pausa" : started ? "Riprendi" : "Avvia timer";
    toggle.disabled = locked || clock.remaining === 0;
    reset.disabled = locked;
    finish.disabled = locked || clock.remaining !== 0 || fields.some((field) => !field.checkValidity());
    if (block.type === "emom") {
      const signature = `${clock.minute}:${clock.remaining === 0}`;
      if (shownMinute !== signature) { shownMinute = signature; renderMinute(clock); }
      const count = block.rounds * block.minutes.length;
      finish.disabled ||= Array.from({ length: count }, (_, i) => !["completed", "missed"].includes(value.minutes?.[i]?.status)).some(Boolean);
    }
  }

  toggle.addEventListener("click", () => guard(() => {
    const clock = timedBlockClock(block, read());
    try {
      save({ timer: { remainingMilliseconds: clock.remaining,
        deadline: clock.running ? null : Date.now() + clock.remaining } });
    } catch (failure) {
      throw new Error(`Timer ${workoutBlockLabel(block)} non salvato. ${failure.message}`);
    }
    shownMinute = null;
    paint();
  }));
  reset.addEventListener("click", () => guard(() => {
    save({ timer: null, rounds: 0, extraReps: "", minutes: {} });
    refresh();
  }));
  finish.addEventListener("click", () => guard(() => {
    const value = read();
    if (timedBlockClock(block, value).remaining !== 0) throw new Error("Attendi la fine del timer.");
    if (block.type === "amrap") {
      parseAmrapCount(value.rounds ?? 0, "Giri completi");
      parseAmrapCount(value.extraReps, "Ripetizioni extra", true);
      if (legacy) updateAmrap(sessionId, { completed: true });
    } else blockCompletionResults({ blocks: [block] }, getProgress(sessionId));
    complete();
  }));
  controls.append(reset, toggle);
  if (getProgress(sessionId).history.length && back) {
    const button = createButton("Indietro", "btn btn-secondary");
    button.addEventListener("click", () => guard(back));
    actions.appendChild(button);
  }
  actions.appendChild(finish);
  card.append(controls, error, actions);
  if (locked) card.appendChild(textEl("p", "Risultato di questo allenamento già salvato, in sola lettura.", "view-description"));
  guard(paint);
  return { element: card, refresh: () => guard(paint, false), dispose: () => {
    disposed = true;
    window.clearInterval(interval);
  } };
}
