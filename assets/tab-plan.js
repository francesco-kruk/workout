function renderPlan(container, plan, onInspectDay, onEditExercise) {
  container.replaceChildren();

  const intro = document.createElement("section");
  intro.className = "view-intro";
  intro.append(
    textEl("h3", "Tutte le giornate")
  );
  intro.appendChild(
    textEl(
      "p",
      `${plan.sessions.length} giornate · apri una giornata per i dettagli`,
      "view-description"
    )
  );
  container.appendChild(intro);

  const warmup = document.createElement("section");
  warmup.className = "overview-card";
  warmup.appendChild(textEl("h3", "Riscaldamento"));
  const warmupList = document.createElement("div");
  warmupList.className = "readonly-list";
  for (const item of plan.warmup) {
    warmupList.appendChild(createReadonlyItem(item.name, item.target, item.instructions));
  }
  warmup.appendChild(warmupList);
  if (plan.warmup.length) container.appendChild(warmup);

  const sessions = document.createElement("div");
  sessions.className = "plan-sessions";
  plan.sessions.forEach((session, index) => {
    const details = document.createElement("details");
    details.className = "overview-card plan-day";
    const count = session.blocks ? session.blocks.reduce((total, block) => total + getBlockExercises(block).length, 0) : session.exercises.length;
    details.appendChild(textEl("summary", `${index + 1}. ${session.label} · ${count} esercizi`));
    if (onInspectDay) {
      const inspect = createButton("Vedi giornata", "btn btn-secondary");
      inspect.addEventListener("click", () => onInspectDay(session.id));
      details.appendChild(inspect);
    }
    details.appendChild(renderPlanSession(session, index, plan.sessions.length, onEditExercise));
    sessions.appendChild(details);
  });
  container.appendChild(sessions);
}

function renderPlanSession(session, index, total, onEditExercise) {
  const card = document.createElement("section");
  card.className = "overview-card plan-session";

  const heading = document.createElement("div");
  heading.className = "overview-heading";
  const title = document.createElement("div");
  title.append(
    textEl("p", `Giornata ${index + 1} di ${total}`, "cycle-label"),
    textEl("h3", session.label)
  );
  heading.appendChild(title);
  if (session.subtitle) {
    heading.appendChild(textEl("span", session.subtitle, "session-badge"));
  }
  card.appendChild(heading);
  if (session.type === "amrap") {
    card.appendChild(textEl("p", `Durata AMRAP: ${session.duration}`, "exercise-target"));
  }

  if (session.instructions) {
    card.appendChild(textEl("p", session.instructions, "exercise-instructions"));
  }

  if (session.blocks) {
    for (const block of session.blocks) card.appendChild(renderPlanBlock(block, onEditExercise));
    return card;
  }

  const list = document.createElement("div");
  list.className = "readonly-list";
  for (const exercise of session.exercises) {
    const setLabel =
      session.type === "amrap"
        ? exercise.target
        : `${exercise.sets}${exercise.optionalSets ? `+${exercise.optionalSets}` : ""} serie · ${exercise.target}`;
    list.appendChild(
      createReadonlyItem(exercise.name, setLabel, exercise.instructions, session.type === "standard" ? exercise.rest : undefined)
    );
    if (session.type === "standard") {
      list.lastElementChild.appendChild(textEl("p", formatExerciseTracking(exercise), "view-description"));
    }
    if (onEditExercise) {
      const edit = createButton(`Modifica ${exercise.name || "esercizio"}`, "btn btn-secondary");
      edit.addEventListener("click", () => onEditExercise(exercise.id));
      list.lastElementChild.appendChild(edit);
    }
  }
  card.appendChild(list);
  return card;
}

function renderPlanBlock(block, onEditExercise) {
  const card = document.createElement("section");
  card.className = `overview-card workout-block block-${block.type}`;
  card.append(textEl("p", workoutBlockLabel(block), "cycle-label"), textEl("h4", block.label));
  if (block.instructions) card.appendChild(textEl("p", block.instructions, "exercise-instructions"));
  if (block.type === "superset") card.appendChild(textEl("p",
    `${block.rounds}${block.optionalRounds ? `+${block.optionalRounds}` : ""} giri · nessun recupero tra esercizi · recupero a fine giro: ${formatRest(block.restSeconds)}`, "exercise-target"));
  if (block.type === "amrap") card.appendChild(textEl("p", `Durata AMRAP: ${block.durationMinutes} minuti`, "exercise-target"));
  if (block.type === "emom") card.appendChild(textEl("p",
    `${block.rounds} giri × ${block.minutes.length} minuti · ${block.rounds * block.minutes.length} minuti totali · 60 secondi per minuto`, "exercise-target"));
  const groups = block.type === "emom" ? block.minutes : [{ exercises: block.exercises }];
  groups.forEach((group, index) => {
    const list = document.createElement("div");
    list.className = "readonly-list";
    if (block.type === "emom") list.appendChild(textEl("h4", `Minuto ${index + 1}`));
    for (const exercise of group.exercises) {
      const target = block.type === "standard"
        ? `${exercise.sets}${exercise.optionalSets ? `+${exercise.optionalSets}` : ""} serie · ${exercise.target}` : exercise.target;
      const row = createReadonlyItem(exercise.name, target, exercise.instructions, block.type === "standard" ? exercise.rest : undefined);
      if (block.type !== "amrap") row.appendChild(textEl("p", formatExerciseTracking(exercise), "view-description"));
      if (onEditExercise) {
        const edit = createButton(`Modifica ${exercise.name || "esercizio"}`, "btn btn-secondary");
        edit.addEventListener("click", () => onEditExercise(exercise.id));
        row.appendChild(edit);
      }
      list.appendChild(row);
    }
    card.appendChild(list);
  });
  return card;
}

function createReadonlyItem(name, target, instructions, rest) {
  const item = document.createElement("article");
  item.className = "readonly-item";
  item.append(textEl("h4", name), textEl("p", target, "exercise-target"));
  if (rest !== undefined) item.appendChild(textEl("p", `Recupero: ${formatRest(rest)}`, "exercise-rest"));
  if (instructions) {
    item.appendChild(textEl("p", instructions, "exercise-instructions"));
  }
  return item;
}
