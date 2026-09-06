function renderWorkout(container, plan, onSessionAdvanced) {
  let timerId = null;
  let timerCleanup = null;

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
    container.replaceChildren();

    const sessionId = getCurrentSessionId(plan);
    const sessionIndex = plan.sessions.findIndex((item) => item.id === sessionId);
    const session = plan.sessions[sessionIndex];
    if (!session) {
      container.appendChild(textEl("p", "Nessun allenamento disponibile."));
      return;
    }

    const summary = getSessionSummary(plan, session);
    container.appendChild(
      createSessionHeading(
        session,
        `Allenamento · giornata ${sessionIndex + 1} di ${plan.sessions.length}`
      )
    );
    container.appendChild(renderJumpControls(session, summary));
    container.appendChild(createProgress(summary, "step completati"));

    if (summary.currentIndex < 0) {
      container.appendChild(renderCompletion(session, summary));
      return;
    }

    const step = summary.steps[summary.currentIndex];
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
      container.appendChild(renderStepActions(step, summary.progress));
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
      completeStepsBefore(plan, session.id, exerciseSelect.value);
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
    if (step.exercise.rest) {
      card.appendChild(
        textEl("p", `Recupero dopo la serie: ${step.exercise.rest}`, "focus-rest")
      );
    }
    if (step.exercise.instructions) {
      card.appendChild(
        textEl("p", step.exercise.instructions, "focus-instructions")
      );
    }
    return card;
  }

  function renderStepActions(step, progress) {
    const actions = document.createElement("div");
    actions.className = "workout-actions";

    if (progress.history.length > 0) {
      const back = createButton("Indietro", "btn btn-secondary");
      back.addEventListener("click", () => {
        undoLastStep(getCurrentSessionId(plan));
        renderCurrent();
      });
      actions.appendChild(back);
    }

    if (step.optional) {
      const skip = createButton("Salta", "btn btn-secondary");
      skip.addEventListener("click", () => {
        setStepStatus(getCurrentSessionId(plan), step.key, "skipped");
        renderCurrent();
      });
      actions.appendChild(skip);
    }

    const complete = createButton(
      step.type === "warmup" ? "Riscaldamento completato" : "Serie completata",
      "btn btn-primary"
    );
    complete.addEventListener("click", () => {
      setStepStatus(getCurrentSessionId(plan), step.key, "completed");
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
    decrement.addEventListener("click", () => {
      rounds = Math.max(0, rounds - 1);
      updateAmrap(session.id, { rounds });
      roundsLabel.textContent = String(rounds);
      decrement.disabled = rounds === 0;
    });
    increment.addEventListener("click", () => {
      rounds += 1;
      updateAmrap(session.id, { rounds });
      roundsLabel.textContent = String(rounds);
      decrement.disabled = false;
    });
    roundsControl.append(decrement, roundsLabel, roundsText, increment);
    card.appendChild(roundsControl);

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
      complete.disabled = remainingMilliseconds !== 0;
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
        completed: false,
      });
      roundsLabel.textContent = "0";
      decrement.disabled = true;
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
      updateAmrap(session.id, { completed: true });
      setStepStatus(session.id, step.key, "completed");
      renderCurrent();
    });
    actions.appendChild(complete);
    card.appendChild(actions);
    updateTimerUi();
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
          ? `Hai completato ${summary.progress.amrap.rounds} giri.`
          : `${summary.completedRequired} attività obbligatorie completate.`,
        "view-description"
      )
    );

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
    stopTimer();
  };
}

function createButton(label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}
