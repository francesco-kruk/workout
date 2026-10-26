function renderDay(container, plan, sessionId = getCurrentSessionId(plan)) {
  container.replaceChildren();

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
      : "Il progresso si aggiorna dalla tab Allenamento. Qui puoi consultare la giornata senza modificarlo.",
    `day-hint${summary.complete ? " complete" : ""}`
  );
  container.appendChild(hint);

  if (plan.warmup.length) container.appendChild(renderDayWarmup(plan.warmup, summary.progress));
  if (session.blocks) {
    for (const block of session.blocks) {
      const card = renderPlanBlock(block);
      if (["standard", "superset"].includes(block.type)) {
        const sets = document.createElement("div");
        sets.className = "readonly-list";
        for (const exercise of block.exercises) {
          const row = document.createElement("div");
          row.className = "day-set-statuses";
          row.appendChild(textEl("span", exercise.name));
          const required = block.type === "superset" ? block.rounds : exercise.sets;
          const optional = block.type === "superset" ? block.optionalRounds || 0 : exercise.optionalSets || 0;
          for (let i = 0; i < required + optional; i++) row.appendChild(createStatusBadge(
            `${block.type === "superset" ? "Giro " : ""}${i + 1}${i >= required ? " opz." : ""}`,
            summary.progress.steps[`${exercise.id}:${i}`] || "pending", i >= required));
          sets.appendChild(row);
        }
        card.appendChild(sets);
      } else {
        const value = summary.progress.blocks[block.id] || {};
        if (block.type === "amrap") card.appendChild(textEl("p", formatAmrapResult(value.rounds || 0, value.extraReps)));
        else {
          const minutes = Object.values(value.minutes || {});
          card.appendChild(textEl("p", `${minutes.filter((m) => m.status === "completed").length} minuti completati · ${minutes.filter((m) => m.status === "missed").length} mancati`));
        }
        card.appendChild(createStatusBadge(summary.progress.steps[`${block.id}:${block.type}`] ? "Completato" : "Da completare",
          summary.progress.steps[`${block.id}:${block.type}`] || "pending"));
      }
      container.appendChild(card);
    }
  } else if (session.type === "amrap") {
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
  card.appendChild(textEl("p", formatExerciseTracking(exercise), "view-description"));

  if (exercise.rest !== undefined) {
    card.appendChild(textEl("p", `Recupero: ${formatRest(exercise.rest)}`, "exercise-rest"));
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
    textEl("strong", formatAmrapResult(progress.amrap.rounds, progress.amrap.extraReps)),
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
