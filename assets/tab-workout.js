function renderWorkout(container, plan) {
  container.replaceChildren();

  const sessionId = getCurrentSessionId(plan);
  const sessionIndex = plan.sessions.findIndex((item) => item.id === sessionId);
  const session = plan.sessions[sessionIndex];
  if (!session) {
    container.appendChild(textEl("p", "Nessuna sessione disponibile."));
    return;
  }

  const progress = getProgress(session.id);
  const requiredKeys = getRequiredKeys(session);

  const cycle = document.createElement("div");
  cycle.className = "cycle-label";
  cycle.textContent = `Sessione ${sessionIndex + 1} di ${plan.sessions.length} · ciclo continuo`;
  container.appendChild(cycle);

  const titleWrap = document.createElement("div");
  titleWrap.className = "session-heading";
  titleWrap.appendChild(textEl("h2", session.label));
  if (session.subtitle) {
    titleWrap.appendChild(textEl("span", session.subtitle, "session-badge"));
  }
  container.appendChild(titleWrap);

  const progressWrap = document.createElement("div");
  progressWrap.className = "progress-wrap";
  const progressBar = document.createElement("div");
  progressBar.className = "progress-bar";
  const progressFill = document.createElement("div");
  progressFill.className = "progress-fill";
  progressBar.appendChild(progressFill);
  const progressLabel = textEl("span", "", "progress-label");
  progressWrap.append(progressBar, progressLabel);
  container.appendChild(progressWrap);

  container.appendChild(renderWarmup(plan.warmup));

  if (session.type === "amrap") {
    container.appendChild(renderAmrap(session, progress, onProgressChange));
  } else {
    const list = document.createElement("div");
    list.className = "exercise-list";
    for (const exercise of session.exercises) {
      list.appendChild(renderExercise(session.id, exercise, progress, onProgressChange));
    }
    container.appendChild(list);
  }

  const completeButton = document.createElement("button");
  completeButton.className = "btn btn-primary complete-button";
  completeButton.textContent = "Completa sessione";
  completeButton.addEventListener("click", () => {
    const nextId = nextSessionId(plan, session.id);
    if (!nextId) return;
    setCurrentSessionId(nextId);
    clearProgress(nextId);
    renderWorkout(container, plan);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  container.appendChild(completeButton);

  function onProgressChange(key, checked) {
    setChecked(session.id, key, checked);
    updateCompletionState();
  }

  function updateCompletionState() {
    const latest = getProgress(session.id);
    const completed = requiredKeys.filter((key) => latest.checked[key]).length;
    const total = requiredKeys.length;
    const percentage = total === 0 ? 100 : Math.round((completed / total) * 100);

    progressFill.style.width = `${percentage}%`;
    progressLabel.textContent = `${completed} di ${total} serie completate`;
    completeButton.disabled = completed !== total;
  }

  updateCompletionState();
}

function renderWarmup(items) {
  const details = document.createElement("details");
  details.className = "warmup-card";

  const summary = document.createElement("summary");
  summary.appendChild(textEl("span", "Riscaldamento", "warmup-title"));
  summary.appendChild(textEl("span", `${items.length} esercizi`, "warmup-count"));
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "warmup-list";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "warmup-row";
    row.appendChild(textEl("h3", item.name));
    row.appendChild(textEl("p", item.target, "exercise-target"));
    if (item.instructions) {
      row.appendChild(textEl("p", item.instructions, "exercise-instructions"));
    }
    list.appendChild(row);
  }
  details.appendChild(list);
  return details;
}

function renderExercise(sessionId, exercise, progress, onProgressChange) {
  const card = document.createElement("article");
  card.className = "exercise-card";

  const header = document.createElement("div");
  header.className = "exercise-header";
  const heading = document.createElement("div");
  heading.appendChild(textEl("h3", exercise.name));
  heading.appendChild(textEl("p", exercise.target, "exercise-target"));
  header.appendChild(heading);
  header.appendChild(textEl("span", `${exercise.sets}${exercise.optionalSets ? `+${exercise.optionalSets}` : ""} serie`, "sets-badge"));
  card.appendChild(header);

  if (exercise.rest) {
    card.appendChild(textEl("p", `Recupero: ${exercise.rest}`, "exercise-rest"));
  }
  if (exercise.instructions) {
    const details = document.createElement("details");
    details.className = "instructions";
    const summary = document.createElement("summary");
    summary.textContent = "Specifiche tecniche";
    details.append(summary, textEl("p", exercise.instructions));
    card.appendChild(details);
  }

  const checks = document.createElement("div");
  checks.className = "set-checks";
  const totalSets = exercise.sets + (exercise.optionalSets || 0);
  for (let index = 0; index < totalSets; index += 1) {
    const key = `${exercise.id}:${index}`;
    const optional = index >= exercise.sets;
    checks.appendChild(
      createCheck(
        key,
        optional ? `${index + 1} opz.` : String(index + 1),
        Boolean(progress.checked[key]),
        onProgressChange,
        optional
      )
    );
  }
  card.appendChild(checks);
  return card;
}

function renderAmrap(session, progress, onProgressChange) {
  const card = document.createElement("article");
  card.className = "amrap-card";
  card.appendChild(textEl("p", session.instructions, "amrap-intro"));

  const list = document.createElement("ol");
  list.className = "amrap-list";
  for (const exercise of session.exercises) {
    const item = document.createElement("li");
    const content = document.createElement("div");
    content.appendChild(textEl("h3", exercise.name));
    content.appendChild(textEl("p", exercise.target, "exercise-target"));
    if (exercise.instructions) {
      content.appendChild(textEl("p", exercise.instructions, "exercise-instructions"));
    }
    item.appendChild(content);
    list.appendChild(item);
  }
  card.appendChild(list);

  const key = `${session.id}:amrap`;
  const checkWrap = document.createElement("div");
  checkWrap.className = "amrap-check";
  checkWrap.appendChild(
    createCheck(
      key,
      `AMRAP completato (${session.duration})`,
      Boolean(progress.checked[key]),
      onProgressChange
    )
  );
  card.appendChild(checkWrap);
  return card;
}

function createCheck(key, labelText, checked, onProgressChange, optional = false) {
  const label = document.createElement("label");
  label.className = `set-check${optional ? " optional" : ""}`;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => {
    label.classList.toggle("checked", input.checked);
    onProgressChange(key, input.checked);
  });

  label.classList.toggle("checked", checked);
  label.append(input, textEl("span", labelText));
  return label;
}

function getRequiredKeys(session) {
  if (session.type === "amrap") {
    return [`${session.id}:amrap`];
  }

  return session.exercises.flatMap((exercise) =>
    Array.from({ length: exercise.sets }, (_, index) => `${exercise.id}:${index}`)
  );
}

function textEl(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
