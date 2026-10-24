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
    details.appendChild(textEl("summary", `${index + 1}. ${session.label} · ${session.exercises.length} esercizi`));
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
