function renderWorkout(container, plan, onSessionAdvanced) {
  let timerId = null;
  let timerCleanup = null;
  let refreshExerciseTimer = null;
  let active = true;
  let manualNotice = "";
  function updateAudioStatus() {
    const status = container.querySelector("[data-audio-status]");
    if (status) {
      status.textContent = window.workoutAudio.error();
      status.hidden = !status.textContent;
    }
  }
  function prepareAudio() {
    const progress = getProgress(getCurrentSessionId(plan));
    if ([progress.restTimer, progress.exerciseTimer].some((timer) => timer && timer.deadline !== null)) {
      void window.workoutAudio.prepare();
    }
  }
  container.addEventListener("click", prepareAudio);
  window.addEventListener("workout-audio-change", updateAudioStatus);
  function updateSocialStatus() {
    const status = container.querySelector("[data-social-status]");
    if (status) {
      const social = window.workoutSocial;
      status.textContent = social.snapshot().error || social.completionMessage(status.dataset.socialStatus);
    }
  }
  window.addEventListener("workout-social-change", updateSocialStatus);
  function manualCompleted(event) {
    if (!active) return;
    manualNotice = event.detail.message;
    renderCurrent();
  }
  window.addEventListener("workout-manual-complete", manualCompleted);
  window.addEventListener("workout-manual-will-complete", stopTimer);
  function resumeRestView() {
    if (!active || document.hidden) return;
    if (refreshExerciseTimer) refreshExerciseTimer(true);
    const sessionId = getCurrentSessionId(plan);
    const rest = getProgress(sessionId).restTimer;
    if (rest && ((rest.deadline !== null && rest.deadline <= Date.now())
      || rest.remainingMilliseconds === 0)) {
      finishRest(sessionId, Boolean(container.querySelector(".rest-timer")));
    }
  }
  document.addEventListener("visibilitychange", resumeRestView);

  function finishRest(sessionId, notify) {
    if (!active || !getProgress(sessionId).restTimer) return;
    clearRestTimer(sessionId);
    if (notify) window.workoutAudio.play();
    renderCurrent();
  }

  function stopTimer() {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    if (timerCleanup) {
      const cleanup = timerCleanup;
      timerCleanup = null;
      cleanup();
    }
  }

  function renderCurrent() {
    stopTimer();
    refreshExerciseTimer = null;
    container.replaceChildren();

    const sessionId = getCurrentSessionId(plan);
    const sessionIndex = plan.sessions.findIndex((item) => item.id === sessionId);
    const session = plan.sessions[sessionIndex];
    if (!session) {
      container.appendChild(textEl("p", "Nessun allenamento disponibile."));
      return;
    }

    const summary = getSessionSummary(plan, session);
    if (manualNotice) {
      const notice = textEl("p", manualNotice, "social-status");
      notice.setAttribute("role", "status");
      container.appendChild(notice);
    }
    container.appendChild(
      createSessionHeading(
        session,
        `Allenamento · giornata ${sessionIndex + 1} di ${plan.sessions.length}`
      )
    );
    const audioStatus = textEl("p", "", "social-status error");
    audioStatus.dataset.audioStatus = "";
    audioStatus.setAttribute("role", "status");
    container.appendChild(audioStatus);
    updateAudioStatus();
    container.appendChild(renderJumpControls(session, summary));
    container.appendChild(createProgress(summary, "step completati"));
    if (!summary.complete && !hasRecordedWorkout(summary.progress.runId)) {
      const manual = window.renderManualWorkoutForm?.(plan, session);
      if (manual) container.appendChild(manual);
    }

    if (session.type !== "amrap" && summary.progress.restTimer) {
      const rest = summary.progress.restTimer;
      if (rest.remainingMilliseconds === 0 || (rest.deadline !== null && rest.deadline <= Date.now())) {
        clearRestTimer(session.id);
      } else {
        container.appendChild(renderRestTimer(session.id, rest, summary));
        return;
      }
    }

    if (summary.currentIndex < 0) {
      container.appendChild(renderCompletion(session, summary));
      return;
    }

    const step = summary.steps[summary.currentIndex];
    if (summary.progress.exerciseTimer && (step.type !== "set"
      || getExerciseTracking(step.exercise).mode !== "seconds"
      || summary.progress.exerciseTimer.stepKey !== step.key)) {
      updateExerciseTimer(sessionId, null);
    }
    const stepMeta = textEl(
      "p",
      `Step ${summary.currentIndex + 1} di ${summary.steps.length}`,
      "step-counter"
    );
    container.appendChild(stepMeta);

    if (step.type === "warmup") {
      container.appendChild(renderWarmupStep(step));
    } else if (step.type === "set") {
      container.appendChild(renderSetStep(step));
    } else {
      container.appendChild(renderAmrapStep(step, summary.progress));
    }

    if (step.type !== "amrap") {
      container.appendChild(renderStepActions(step, summary));
    }
  }

  function renderJumpControls(session, summary) {
    const controls = document.createElement("section");
    controls.className = "jump-controls";
    controls.setAttribute("aria-label", "Navigazione rapida");

    const dayField = createJumpField("Giorno");
    const daySelect = document.createElement("select");
    daySelect.setAttribute("aria-label", "Vai a un giorno");
    for (const item of plan.sessions) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      option.selected = item.id === session.id;
      daySelect.appendChild(option);
    }
    daySelect.addEventListener("change", () => {
      setCurrentSessionId(daySelect.value);
      renderCurrent();
    });
    dayField.appendChild(daySelect);

    const exerciseField = createJumpField("Esercizio");
    const exerciseSelect = document.createElement("select");
    exerciseSelect.setAttribute("aria-label", "Vai a un esercizio");

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Scegli esercizio";
    exerciseSelect.appendChild(placeholder);

    const destinations = getExerciseDestinations(session);
    const currentStep = summary.steps[summary.currentIndex];
    const currentDestinationKey = getExerciseDestinationKey(currentStep);
    for (const destination of destinations) {
      const option = document.createElement("option");
      option.value = destination.key;
      option.textContent = destination.label;
      option.selected = destination.key === currentDestinationKey;
      exerciseSelect.appendChild(option);
    }
    exerciseSelect.addEventListener("change", () => {
      if (!exerciseSelect.value) return;
      applyWorkoutProgress(plan, session.id, () => {
        completeStepsBefore(plan, session.id, exerciseSelect.value);
      });
      renderCurrent();
    });
    exerciseField.appendChild(exerciseSelect);

    controls.append(dayField, exerciseField);
    return controls;
  }

  function createJumpField(label) {
    const field = document.createElement("label");
    field.className = "jump-field";
    field.appendChild(textEl("span", label));
    return field;
  }

  function getExerciseDestinations(session) {
    if (session.type === "amrap") {
      return [
        {
          key: `${session.id}:amrap`,
          label: session.subtitle || "Circuito AMRAP",
        },
      ];
    }

    return session.exercises.map((exercise) => ({
      key: `${exercise.id}:0`,
      label: exercise.name,
    }));
  }

  function getExerciseDestinationKey(step) {
    if (step?.type === "set") return `${step.exercise.id}:0`;
    if (step?.type === "amrap") return step.key;
    return "";
  }

  function renderWarmupStep(step) {
    const card = document.createElement("article");
    card.className = "focus-card";
    card.append(
      textEl("p", `Riscaldamento ${step.position} di ${step.total}`, "focus-kicker"),
      textEl("h3", step.item.name),
      textEl("p", step.item.target, "focus-target")
    );
    if (step.item.instructions) {
      card.appendChild(textEl("p", step.item.instructions, "focus-instructions"));
    }
    return card;
  }

  function renderSetStep(step) {
    const card = document.createElement("article");
    card.className = "focus-card";
    card.append(
      textEl(
        "p",
        `Esercizio ${step.exerciseIndex + 1} · serie ${step.setNumber} di ${step.totalSets}${step.optional ? " · opzionale" : ""}`,
        "focus-kicker"
      ),
      textEl("h3", step.exercise.name),
      textEl("p", step.exercise.target, "focus-target")
    );
    if (step.exercise.rest !== undefined) {
      card.appendChild(
        textEl("p", `Recupero dopo la serie: ${formatRest(step.exercise.rest)}`, "focus-rest")
      );
    }
    if (step.exercise.instructions) {
      card.appendChild(
        textEl("p", step.exercise.instructions, "focus-instructions")
      );
    }
    const sessionId = getCurrentSessionId(plan);
    const stored = getProgress(sessionId);
    const { mode, usesWeight } = getExerciseTracking(step.exercise);
    if (mode === "seconds" && !hasRecordedWorkout(stored.runId)) {
      card.appendChild(renderExerciseTimer(sessionId, step));
    }
    const values = { ...stored.results[step.key], mode };
    const fields = document.createElement("fieldset");
    fields.className = "actual-results";
    fields.appendChild(textEl("legend", "Risultato effettivo"));
    const hint = textEl("p", `Inserisci ${mode === "seconds" ? "la durata" : "le ripetizioni"}${usesWeight ? " e il peso (anche 0 kg)" : ""} per completare la serie.`, "view-description");
    hint.id = `measurement-hint-${step.exercise.id}`;
    fields.appendChild(hint);
    const error = textEl("p", "", "social-status error");
    error.dataset.measurementError = "";
    error.id = `measurement-error-${step.exercise.id}`;
    error.setAttribute("role", "alert");
    const inputs = document.createElement("div");
    inputs.className = "measurement-inputs";
    function persist() {
      try {
        updateSetResult(sessionId, step.key, values);
        error.textContent = validateActualNumbers() || validateNotes();
      } catch (failure) {
        console.error("Salvataggio risultato locale non riuscito.", failure);
        error.textContent = `Risultato non salvato. ${failure.message}`;
      }
      updateSetCompletionAvailability();
    }
    for (const [key, label, max, increment] of [
      ...(usesWeight ? [["weightKg", "Peso (kg)", 2000, "0.01"]] : []),
      [mode, mode === "seconds" ? "Durata (secondi)" : "Ripetizioni", mode === "seconds" ? 86400 : 100000, "1"],
    ]) {
      const wrapper = textEl("label", label);
      const input = document.createElement("input");
      input.type = "number";
      input.required = true;
      input.min = "0";
      input.max = String(max);
      input.step = increment;
      input.inputMode = key === "weightKg" ? "decimal" : "numeric";
      input.value = values[key] ?? "";
      input.dataset.actualField = key;
      input.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
      input.addEventListener("input", () => {
        values[key] = input.validity.badInput ? "invalid" : input.value;
        persist();
      });
      wrapper.appendChild(input);
      inputs.appendChild(wrapper);
    }
    const notesLabel = textEl("label", "Note della serie (facoltative)");
    const notes = document.createElement("input");
    notes.type = "text";
    notes.maxLength = 1000;
    notes.value = values.notes ?? "";
    notes.dataset.setNotes = "";
    notes.setAttribute("aria-describedby", error.id);
    function validateNotes() {
      try {
        parseSetResult({ notes: values.notes });
        notes.setAttribute("aria-invalid", "false");
        return "";
      } catch (failure) {
        notes.setAttribute("aria-invalid", "true");
        return failure.message;
      }
    }
    notes.addEventListener("input", () => {
      values.notes = notes.value;
      persist();
    });
    notesLabel.appendChild(notes);
    fields.append(inputs, notesLabel, error);
    const notesError = validateNotes();
    if (notesError) error.textContent = notesError;
    if (hasRecordedWorkout(stored.runId)) {
      fields.disabled = true;
      fields.appendChild(textEl("p", "Risultato di questo allenamento già salvato, in sola lettura.", "view-description"));
    }
    card.appendChild(fields);
    for (const input of inputs.querySelectorAll("input")) {
      if (input.value) {
        const message = validateNumberInput(input, input.parentElement.firstChild.textContent);
        if (message) error.textContent = message;
      }
    }
    appendPrevious(card, sessionId, step.exercise.id, step.setNumber);
    return card;
  }

  function updateSetCompletionAvailability(complete = container.querySelector("[data-complete-set]")) {
    if (!complete) return;
    complete.disabled = Boolean(container.querySelector("[data-measurement-error]")?.textContent)
      || [...container.querySelectorAll("[data-actual-field]")].some((input) => !input.value || !input.checkValidity());
  }

  function validateActualNumbers() {
    return [...container.querySelectorAll("[data-actual-field]")].map((input) =>
      validateNumberInput(input, input.parentElement.firstChild.textContent)
    ).find(Boolean) || "";
  }

  function appendPrevious(card, sessionId, exerciseId = null, setNumber = null) {
    const library = window.workoutLibrary?.snapshot();
    if (!library?.record || library.plan !== plan) return;
    const ownerId = library.userId;
    const reference = textEl("p", "Ultima volta: caricamento...", "previous-result view-description");
    card.appendChild(reference);
    window.workoutSocial.fetchPrevious(sessionId, exerciseId).then((result) => {
      if (!active || !card.isConnected || window.workoutLibrary.snapshot().userId !== ownerId) return;
      const value = exerciseId ? result?.sets?.find((item) => item.set === setNumber) : null;
      reference.textContent = result
        ? `Ultima volta (${new Date(result.completed_at).toLocaleDateString("it-IT", { timeZone: "Europe/Rome" })}): ${
          exerciseId ? formatActualResult(value) : formatAmrapResult(result.rounds, result.extra_reps)
        }. Solo riferimento.`
        : "Ultima volta: nessun risultato confrontabile registrato.";
    }).catch((failure) => {
      if (!active || !card.isConnected || window.workoutLibrary.snapshot().userId !== ownerId) return;
      console.error("Ultimo risultato non disponibile.", failure);
      reference.textContent = `Ultimo risultato non disponibile. ${failure.message} Puoi continuare ad allenarti.`;
    });
  }

  function validateActualInputs() {
    const error = container.querySelector("[data-measurement-error]");
    try {
      for (const input of container.querySelectorAll("[data-actual-field]")) {
        if (!input.checkValidity()) {
          input.reportValidity();
          throw new Error("Controlla i valori inseriti: usa numeri nei limiti indicati.");
        }
      }
      const sessionId = getCurrentSessionId(plan);
      const summary = getSessionSummary(plan, plan.sessions.find((day) => day.id === sessionId));
      const step = summary.steps[summary.currentIndex];
      if (step?.type === "set") {
        const result = parseSetResult(summary.progress.results[step.key], step.exercise);
        const { mode, usesWeight } = getExerciseTracking(step.exercise);
        if (result[mode] === undefined || (usesWeight && result.weightKg === undefined)) {
          throw new Error("Inserisci tutti i risultati richiesti prima di completare la serie.");
        }
      } else if (step?.type === "amrap") {
        parseAmrapCount(summary.progress.amrap.rounds, "Giri completi");
        parseAmrapCount(summary.progress.amrap.extraReps, "Ripetizioni extra", true);
      }
      if (error?.textContent) throw new Error(error.textContent);
      return true;
    } catch (failure) {
      console.error("Risultato non valido.", failure);
      if (error) error.textContent = failure.message;
      return false;
    }
  }

  function renderExerciseTimer(sessionId, step) {
    const panel = document.createElement("section");
    panel.className = "exercise-timer";
    panel.setAttribute("aria-label", "Timer esercizio");
    panel.appendChild(textEl("h4", "Timer esercizio", "focus-kicker"));
    let current = getProgress(sessionId).exerciseTimer;
    const durationLabel = textEl("label", "Timer: durata (secondi)");
    const duration = document.createElement("input");
    duration.type = "number";
    duration.min = "1";
    duration.max = "86400";
    duration.step = "1";
    duration.required = true;
    duration.inputMode = "numeric";
    duration.value = current?.durationSeconds ?? parseExerciseTargetSeconds(step.exercise.target) ?? "";
    durationLabel.appendChild(duration);
    const display = textEl("strong", "", "timer-value");
    const status = textEl("span", "", "timer-status");
    status.setAttribute("role", "status");
    const error = textEl("p", "", "social-status error");
    error.id = `exercise-timer-error-${step.exercise.id}`;
    error.setAttribute("role", "alert");
    duration.setAttribute("aria-describedby", error.id);
    const toggle = createButton("Avvia timer", "btn btn-primary");
    const reset = createButton("Azzera timer", "btn btn-secondary");
    const controls = document.createElement("div");
    controls.className = "timer-controls";
    controls.append(toggle, reset);
    panel.append(durationLabel, display, status, controls, error);

    function validDuration() {
      return duration.checkValidity() && Number.isInteger(duration.valueAsNumber);
    }

    function save(timer) {
      current = updateExerciseTimer(sessionId, timer);
    }

    function guard(action) {
      try {
        action();
      } catch (failure) {
        stopTimer();
        console.error("Timer esercizio non disponibile.", failure);
        error.textContent = `Timer esercizio non salvato. ${failure.message}`;
        toggle.disabled = true;
      }
    }

    function refresh(notify = false) {
      if (!active) return;
      current = getProgress(sessionId).exerciseTimer;
      if (current && current.deadline !== null && current.deadline <= Date.now()) {
        if (current.phase === "setup") {
          const overtime = Date.now() - current.deadline;
          const remainingMilliseconds = Math.max(0, current.durationSeconds * 1000 - overtime);
          save({
            ...current,
            phase: "exercise",
            remainingMilliseconds,
            deadline: remainingMilliseconds > 0 ? Date.now() + remainingMilliseconds : null,
          });
          if (remainingMilliseconds === 0) stopTimer();
          if (notify) window.workoutAudio.play();
        } else {
          save({ ...current, deadline: null, remainingMilliseconds: 0 });
          stopTimer();
          if (notify) window.workoutAudio.play();
        }
      }
      const running = current?.deadline != null;
      const finished = current?.remainingMilliseconds === 0;
      const remaining = current
        ? current.deadline === null ? current.remainingMilliseconds : Math.max(0, current.deadline - Date.now())
        : validDuration() ? duration.valueAsNumber * 1000 : 0;
      display.textContent = formatTime(Math.ceil(remaining / 1000));
      status.textContent = finished ? "Tempo terminato"
        : current?.phase === "setup" ? running ? "Preparati" : "Preparazione in pausa"
          : running ? "Timer in corso" : current ? "Timer in pausa" : "Timer pronto";
      duration.disabled = Boolean(current);
      toggle.textContent = finished ? "Tempo terminato" : running ? "Pausa" : current ? "Riprendi" : "Avvia timer";
      toggle.disabled = finished || (!current && !validDuration());
      reset.disabled = !current;
    }

    function startTicker() {
      if (timerId === null) timerId = window.setInterval(() => guard(() => refresh(true)), 250);
    }

    duration.addEventListener("input", () => {
      error.textContent = validDuration() ? "" : "Inserisci una durata intera da 1 a 86400 secondi.";
      duration.setAttribute("aria-invalid", String(!validDuration()));
      guard(() => refresh());
    });
    toggle.addEventListener("click", () => guard(() => {
      if (current?.deadline != null) {
        if (current.deadline <= Date.now()) {
          refresh(true);
          return;
        }
        save({ ...current, deadline: null, remainingMilliseconds: Math.max(0, current.deadline - Date.now()) });
        stopTimer();
      } else {
        if (!current && !validDuration()) return;
        const phase = current?.phase ?? "setup";
        const milliseconds = current?.remainingMilliseconds
          ?? (phase === "setup" ? window.WORKOUT_EXERCISE_SETUP_SECONDS : duration.valueAsNumber) * 1000;
        save({
          stepKey: step.key,
          durationSeconds: current?.durationSeconds ?? duration.valueAsNumber,
          phase,
          remainingMilliseconds: milliseconds,
          deadline: Date.now() + milliseconds,
        });
        void window.workoutAudio.prepare();
        startTicker();
      }
      refresh();
    }));
    reset.addEventListener("click", () => guard(() => {
      stopTimer();
      save(null);
      error.textContent = "";
      refresh();
    }));
    refreshExerciseTimer = (notify) => guard(() => refresh(notify));
    guard(() => {
      refresh();
      if (current?.deadline != null) startTicker();
    });
    return panel;
  }

  function renderRestTimer(sessionId, initialTimer, summary) {
    const timer = document.createElement("section");
    timer.className = "rest-timer";
    timer.setAttribute("aria-label", "Timer di recupero");

    const title = textEl("p", "Recupero", "focus-kicker");
    const lastStep = summary.steps.find((step) => step.key === summary.progress.history.at(-1));
    timer.appendChild(title);
    if (lastStep?.type === "set") {
      const completedSets = summary.steps.filter((step) =>
        step.type === "set" && step.exercise.id === lastStep.exercise.id
        && summary.progress.steps[step.key] === "completed"
      ).length;
      timer.append(
        textEl("h3", lastStep.exercise.name),
        textEl("p", `${completedSets} di ${lastStep.totalSets} serie completate${lastStep.exercise.optionalSets ? ` (${lastStep.exercise.optionalSets} opzionali)` : ""}`, "view-description")
      );
    }
    const timeDisplay = textEl(
      "strong",
      formatTime(Math.ceil(initialTimer.remainingMilliseconds / 1000)),
      "timer-value"
    );
    const status = textEl("span", "", "timer-status");
    const toggle = createButton("", "btn btn-primary");
    const skip = createButton("Salta recupero", "btn btn-secondary");

    function startTicker() {
      if (timerId !== null) return;
      timerId = window.setInterval(() => {
        const active = getProgress(sessionId).restTimer;
        if (!active || active.deadline === null) {
          stopTimer();
          refreshTimerUi();
          return;
        }
        if (active.deadline <= Date.now()) {
          finishRest(sessionId, true);
          return;
        }
        refreshTimerUi();
      }, 1000);
    }

    function refreshTimerUi() {
      const current = getProgress(sessionId).restTimer;
      if (!current) return;

      const remaining = current.deadline === null
        ? current.remainingMilliseconds
        : Math.max(0, current.deadline - Date.now());
      const finished = remaining === 0;
      const running = current.deadline !== null && !finished;
      timeDisplay.textContent = formatTime(Math.ceil(remaining / 1000));
      status.textContent = finished
        ? "Recupero completato"
        : running
          ? "Timer in corso"
          : "Timer in pausa";
      toggle.textContent = finished ? "Completo" : running ? "Pausa" : "Riprendi";
      toggle.disabled = finished;
    }

    toggle.addEventListener("click", () => {
      const current = getProgress(sessionId).restTimer;
      if (!current) return;
      if (current.deadline !== null && current.deadline <= Date.now()) {
        finishRest(sessionId, true);
        return;
      }

      if (current.deadline !== null) {
        updateRestTimer(sessionId, {
          ...current,
          deadline: null,
          remainingMilliseconds: Math.max(0, current.deadline - Date.now()),
        });
      } else {
        updateRestTimer(sessionId, {
          ...current,
          deadline: Date.now() + current.remainingMilliseconds,
        });
        startTicker();
      }
      refreshTimerUi();
    });

    skip.addEventListener("click", () => {
      clearRestTimer(sessionId);
      renderCurrent();
    });
    timer.append(timeDisplay, status);
    const controls = document.createElement("div");
    controls.className = "timer-controls";
    controls.append(toggle, skip);
    timer.appendChild(controls);
    refreshTimerUi();
    if (initialTimer.deadline !== null) startTicker();
    return timer;
  }

  function renderStepActions(step, summary) {
    const progress = summary.progress;
    const actions = document.createElement("div");
    actions.className = "workout-actions";

    if (progress.history.length > 0) {
      const back = createButton("Indietro", "btn btn-secondary");
      back.addEventListener("click", () => {
        undoLastStep(getCurrentSessionId(plan));
        clearRestTimer(getCurrentSessionId(plan));
        renderCurrent();
      });
      actions.appendChild(back);
    }

    if (step.optional) {
      const skip = createButton("Salta", "btn btn-secondary");
      skip.addEventListener("click", () => {
        const sessionId = getCurrentSessionId(plan);
        applyWorkoutProgress(plan, sessionId, () => {
          setStepStatus(sessionId, step.key, "skipped");
        });
        renderCurrent();
      });
      actions.appendChild(skip);
    }

    const complete = createButton(
      step.type === "warmup" ? "Riscaldamento completato" : "Serie completata",
      "btn btn-primary"
    );
    if (step.type === "set") {
      complete.dataset.completeSet = "";
      complete.setAttribute("aria-describedby", `measurement-hint-${step.exercise.id}`);
      updateSetCompletionAvailability(complete);
    }
    complete.addEventListener("click", () => {
      if (step.type === "set" && !validateActualInputs()) return;
      const sessionId = getCurrentSessionId(plan);
      applyWorkoutProgress(plan, sessionId, () => {
        setStepStatus(sessionId, step.key, "completed");
      });
      const nextSummary = getSessionSummary(plan, plan.sessions.find((day) => day.id === sessionId));
      const nextStep = nextSummary.steps[nextSummary.currentIndex];
      if (step.type === "set" && nextStep?.type === "set"
        && nextStep.exercise.id === step.exercise.id) {
        const durationSeconds = step.exercise.rest;
        if (durationSeconds > 0) {
          updateRestTimer(sessionId, {
            durationSeconds,
            remainingMilliseconds: durationSeconds * 1000,
            deadline: Date.now() + durationSeconds * 1000,
          });
        }
      }
      renderCurrent();
    });
    actions.appendChild(complete);
    return actions;
  }

  function renderAmrapStep(step, progress) {
    const session = step.session;
    const durationSeconds = parseDurationSeconds(session.duration);
    let remainingMilliseconds =
      progress.amrap.remainingMilliseconds === null
        ? durationSeconds * 1000
        : progress.amrap.remainingMilliseconds;
    let rounds = progress.amrap.rounds;
    let deadline = null;

    const card = document.createElement("article");
    card.className = "focus-card amrap-focus";
    card.append(
      textEl("p", "Circuito AMRAP", "focus-kicker"),
      textEl("h3", session.subtitle || session.label),
      textEl("p", session.instructions, "focus-instructions")
    );

    const exercises = document.createElement("ol");
    exercises.className = "amrap-focus-list";
    for (const exercise of session.exercises) {
      const item = document.createElement("li");
      item.append(
        textEl("strong", exercise.name),
        textEl("span", exercise.target)
      );
      exercises.appendChild(item);
    }
    card.appendChild(exercises);

    const timer = document.createElement("div");
    timer.className = "amrap-timer";
    const timeDisplay = textEl(
      "strong",
      formatTime(Math.ceil(remainingMilliseconds / 1000)),
      "timer-value"
    );
    const timerStatus = textEl("span", "Timer in pausa", "timer-status");
    timer.append(timeDisplay, timerStatus);
    card.appendChild(timer);

    const roundsControl = document.createElement("div");
    roundsControl.className = "rounds-control";
    const roundsLabel = textEl("strong", String(rounds), "rounds-value");
    const roundsText = textEl("span", "giri completi");
    const decrement = createButton("−", "btn btn-icon");
    decrement.setAttribute("aria-label", "Rimuovi un giro");
    decrement.disabled = rounds === 0;
    const increment = createButton("+", "btn btn-icon");
    increment.setAttribute("aria-label", "Aggiungi un giro");
    increment.disabled = rounds >= 100000;
    decrement.addEventListener("click", () => {
      rounds = Math.max(0, rounds - 1);
      updateAmrap(session.id, { rounds });
      roundsLabel.textContent = String(rounds);
      decrement.disabled = rounds === 0;
      increment.disabled = false;
    });
    increment.addEventListener("click", () => {
      rounds += 1;
      updateAmrap(session.id, { rounds });
      roundsLabel.textContent = String(rounds);
      decrement.disabled = false;
      increment.disabled = rounds >= 100000;
    });
    roundsControl.append(decrement, roundsLabel, roundsText, increment);
    card.appendChild(roundsControl);
    const extraLabel = textEl("label", "Ripetizioni extra (facoltative)");
    const extra = document.createElement("input");
    extra.type = "number";
    extra.min = "0";
    extra.max = "100000";
    extra.step = "1";
    extra.inputMode = "numeric";
    extra.value = progress.amrap.extraReps;
    extra.dataset.actualField = "extraReps";
    const resultError = textEl("p", "", "social-status error");
    resultError.dataset.measurementError = "";
    resultError.setAttribute("role", "alert");
    extra.addEventListener("input", () => {
      try {
        updateAmrap(session.id, { extraReps: extra.validity.badInput ? "invalid" : extra.value });
        resultError.textContent = validateNumberInput(extra, "Ripetizioni extra");
      } catch (failure) {
        console.error("Salvataggio ripetizioni extra non riuscito.", failure);
        resultError.textContent = `Risultato non salvato. ${failure.message}`;
      }
      updateTimerUi();
    });
    extraLabel.appendChild(extra);
    card.append(extraLabel, textEl("p", "Totale delle ripetizioni svolte dopo l'ultimo giro completo.", "view-description"), resultError);
    appendPrevious(card, session.id);

    const controls = document.createElement("div");
    controls.className = "timer-controls";
    const reset = createButton("Reset", "btn btn-secondary");
    const toggle = createButton(
      remainingMilliseconds === 0 ? "Tempo terminato" : "Avvia timer",
      "btn btn-primary"
    );
    toggle.disabled = remainingMilliseconds === 0;

    function updateTimerUi() {
      timeDisplay.textContent = formatTime(
        Math.ceil(remainingMilliseconds / 1000)
      );
      toggle.textContent =
        remainingMilliseconds === 0
          ? "Tempo terminato"
          : timerId === null
            ? "Avvia timer"
            : "Pausa";
      toggle.disabled = remainingMilliseconds === 0;
      complete.disabled = remainingMilliseconds !== 0 || !extra.checkValidity() || Boolean(resultError.textContent);
      timerStatus.textContent =
        remainingMilliseconds === 0
          ? "Tempo terminato"
          : timerId === null
            ? "Timer in pausa"
            : "Timer in corso";
    }

    toggle.addEventListener("click", () => {
      if (timerId !== null) {
        stopTimer();
        updateTimerUi();
        return;
      }

      deadline = Date.now() + remainingMilliseconds;
      timerCleanup = () => {
        if (deadline === null) return;
        remainingMilliseconds = Math.max(0, deadline - Date.now());
        deadline = null;
        updateAmrap(session.id, { remainingMilliseconds });
      };
      timerId = window.setInterval(() => {
        remainingMilliseconds = Math.max(0, deadline - Date.now());
        updateAmrap(session.id, { remainingMilliseconds });
        if (remainingMilliseconds === 0) stopTimer();
        updateTimerUi();
      }, 1000);
      updateTimerUi();
    });

    reset.addEventListener("click", () => {
      stopTimer();
      remainingMilliseconds = durationSeconds * 1000;
      rounds = 0;
      updateAmrap(session.id, {
        remainingMilliseconds,
        rounds,
        extraReps: "",
        completed: false,
      });
      roundsLabel.textContent = "0";
      extra.value = "";
      extra.setCustomValidity("");
      extra.setAttribute("aria-invalid", "false");
      resultError.textContent = "";
      decrement.disabled = true;
      increment.disabled = false;
      updateTimerUi();
    });
    controls.append(reset, toggle);
    card.appendChild(controls);

    const actions = document.createElement("div");
    actions.className = "workout-actions";
    if (progress.history.length > 0) {
      const back = createButton("Indietro", "btn btn-secondary");
      back.addEventListener("click", () => {
        stopTimer();
        undoLastStep(session.id);
        renderCurrent();
      });
      actions.appendChild(back);
    }
    const complete = createButton("Completa AMRAP", "btn btn-primary");
    complete.disabled = remainingMilliseconds !== 0;
    complete.addEventListener("click", () => {
      if (!validateActualInputs()) return;
      applyWorkoutProgress(plan, session.id, () => {
        updateAmrap(session.id, { completed: true });
        setStepStatus(session.id, step.key, "completed");
      });
      renderCurrent();
    });
    actions.appendChild(complete);
    card.appendChild(actions);
    resultError.id = `extra-reps-error-${session.id}`;
    extra.setAttribute("aria-describedby", resultError.id);
    if (extra.value) resultError.textContent = validateNumberInput(extra, "Ripetizioni extra");
    try {
      parseAmrapCount(rounds, "Giri completi");
      parseAmrapCount(progress.amrap.extraReps, "Ripetizioni extra", true);
    } catch (failure) {
      console.error("Risultato AMRAP non valido.", failure);
      resultError.textContent = failure.message;
    }
    updateTimerUi();
    if (hasRecordedWorkout(progress.runId)) {
      extra.disabled = increment.disabled = decrement.disabled = reset.disabled = true;
      card.appendChild(textEl("p", "Risultato di questo allenamento già salvato, in sola lettura.", "view-description"));
    }
    return card;
  }

  function renderCompletion(session, summary) {
    const card = document.createElement("section");
    card.className = "completion-card";
    card.append(
      textEl("p", "Giornata completata", "focus-kicker"),
      textEl("h3", "Ottimo lavoro!"),
      textEl(
        "p",
        session.type === "amrap"
          ? `Hai completato ${formatAmrapResult(summary.progress.amrap.rounds, summary.progress.amrap.extraReps)}.`
          : `${summary.completedRequired} attività obbligatorie completate.`,
        "view-description"
      )
    );

    const socialStatus = textEl("p", "", "view-description");
    socialStatus.dataset.socialStatus = summary.progress.runId || "";
    socialStatus.setAttribute("role", "status");
    socialStatus.textContent = window.workoutSocial.snapshot().error
      || window.workoutSocial.completionMessage(summary.progress.runId);
    card.appendChild(socialStatus);

    const actions = document.createElement("div");
    actions.className = "workout-actions";
    if (summary.progress.history.length > 0) {
      const back = createButton("Indietro", "btn btn-secondary");
      back.addEventListener("click", () => {
        undoLastStep(session.id);
        renderCurrent();
      });
      actions.appendChild(back);
    }

    const nextId = nextSessionId(plan, session.id);
    const nextSession = plan.sessions.find((item) => item.id === nextId);
    const next = createButton(
      nextSession ? `Passa a ${nextSession.label}` : "Continua",
      "btn btn-primary"
    );
    next.addEventListener("click", () => {
      if (!nextId) return;
      setCurrentSessionId(nextId);
      clearProgress(nextId);
      onSessionAdvanced();
    });
    actions.appendChild(next);
    card.appendChild(actions);
    return card;
  }

  renderCurrent();
  return () => {
    active = false;
    stopTimer();
    window.removeEventListener("workout-social-change", updateSocialStatus);
    window.removeEventListener("workout-manual-complete", manualCompleted);
    window.removeEventListener("workout-manual-will-complete", stopTimer);
    container.removeEventListener("click", prepareAudio);
    window.removeEventListener("workout-audio-change", updateAudioStatus);
    document.removeEventListener("visibilitychange", resumeRestView);
  };
}

function createButton(label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}
