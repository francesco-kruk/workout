function renderDay(container, plan) {
  container.replaceChildren();

  const sessionId = getCurrentSessionId(plan);
  const sessionIndex = plan.sessions.findIndex((item) => item.id === sessionId);
  const session = plan.sessions[sessionIndex];
  if (!session) {
    container.appendChild(textEl("p", "Nessuna giornata disponibile."));
    return;
  }

  const summary = getSessionSummary(plan, session);
  container.appendChild(
    createSessionHeading(
      session,
      `Giornata ${sessionIndex + 1} di ${plan.sessions.length}`
    )
  );
  container.appendChild(createProgress(summary));

  const hint = textEl(
    "p",
    summary.complete
      ? "Allenamento completato. Apri la tab Allenamento per passare alla prossima giornata."
      : "Il progresso si aggiorna automaticamente dalla tab Allenamento.",
    `day-hint${summary.complete ? " complete" : ""}`
  );
  container.appendChild(hint);

  container.appendChild(renderDayWarmup(plan.warmup, summary.progress));
  if (session.type === "amrap") {
    container.appendChild(renderDayAmrap(session, summary.progress));
  } else {
    const list = document.createElement("div");
    list.className = "exercise-list";
    for (const exercise of session.exercises) {
      list.appendChild(renderDayExercise(exercise, summary.progress));
    }
    container.appendChild(list);
  }
}

function renderDayWarmup(items, progress) {
  const card = document.createElement("section");
  card.className = "overview-card";
  card.appendChild(textEl("h3", "Riscaldamento"));

  const list = document.createElement("div");
  list.className = "readonly-list";
  for (const item of items) {
    const row = createStatusRow(
      item.name,
      item.target,
      progress.steps[getWarmupKey(item)] || "pending"
    );
    if (item.instructions) {
      row.querySelector(".status-content").appendChild(
        textEl("p", item.instructions, "exercise-instructions")
      );
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function renderDayExercise(exercise, progress) {
  const card = document.createElement("section");
  card.className = "exercise-card day-exercise";

  const header = document.createElement("div");
  header.className = "exercise-header";
  const heading = document.createElement("div");
  heading.append(
    textEl("h3", exercise.name),
    textEl("p", exercise.target, "exercise-target")
  );
  header.append(
    heading,
    textEl(
      "span",
      `${exercise.sets}${exercise.optionalSets ? `+${exercise.optionalSets}` : ""} serie`,
      "sets-badge"
    )
  );
  card.appendChild(header);

  if (exercise.rest) {
    card.appendChild(textEl("p", `Recupero: ${exercise.rest}`, "exercise-rest"));
  }
  if (exercise.instructions) {
    card.appendChild(textEl("p", exercise.instructions, "exercise-instructions"));
  }

  const sets = document.createElement("div");
  sets.className = "day-set-statuses";
  const totalSets = exercise.sets + (exercise.optionalSets || 0);
  for (let index = 0; index < totalSets; index += 1) {
    const optional = index >= exercise.sets;
    const status = progress.steps[`${exercise.id}:${index}`] || "pending";
    sets.appendChild(
      createStatusBadge(
        optional ? `${index + 1} opz.` : String(index + 1),
        status,
        optional
      )
    );
  }
  card.appendChild(sets);
  return card;
}

function renderDayAmrap(session, progress) {
  const card = document.createElement("section");
  card.className = "amrap-card day-amrap";
  card.append(
    textEl("h3", session.subtitle || "AMRAP"),
    textEl("p", session.instructions, "exercise-instructions")
  );

  const list = document.createElement("div");
  list.className = "readonly-list";
  for (const exercise of session.exercises) {
    list.appendChild(createReadonlyItem(exercise.name, exercise.target, exercise.instructions));
  }
  card.appendChild(list);

  const result = document.createElement("div");
  result.className = "amrap-result";
  result.append(
    textEl("strong", `${progress.amrap.rounds} giri`),
    createStatusBadge(
      progress.steps[`${session.id}:amrap`] ? "Completato" : "Da completare",
      progress.steps[`${session.id}:amrap`] || "pending"
    )
  );
  card.appendChild(result);
  return card;
}

function createStatusRow(name, target, status) {
  const row = document.createElement("article");
  row.className = "status-row";
  const content = document.createElement("div");
  content.className = "status-content";
  content.append(textEl("h4", name), textEl("p", target, "exercise-target"));
  row.append(content, createStatusBadge(statusLabel(status), status));
  return row;
}

function createStatusBadge(label, status, optional = false) {
  const badge = textEl("span", label, `status-badge ${status}`);
  badge.setAttribute("aria-label", `${label}: ${statusLabel(status)}`);
  if (optional) badge.classList.add("optional");
  return badge;
}

function statusLabel(status) {
  if (status === "completed") return "Fatto";
  if (status === "skipped") return "Saltato";
  return "Da fare";
}
