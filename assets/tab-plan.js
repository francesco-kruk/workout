function renderPlan(container, plan) {
  container.replaceChildren();

  const intro = document.createElement("section");
  intro.className = "view-intro";
  intro.append(
    textEl("p", "Panoramica completa", "cycle-label"),
    textEl("h2", plan.title)
  );
  intro.appendChild(
    textEl(
      "p",
      `${plan.sessions.length} giornate · consultazione senza modifiche`,
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
  container.appendChild(warmup);

  const sessions = document.createElement("div");
  sessions.className = "plan-sessions";
  plan.sessions.forEach((session, index) => {
    sessions.appendChild(renderPlanSession(session, index, plan.sessions.length));
  });
  container.appendChild(sessions);
}

function renderPlanSession(session, index, total) {
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
      createReadonlyItem(exercise.name, setLabel, exercise.instructions, exercise.rest)
    );
  }
  card.appendChild(list);
  return card;
}

function createReadonlyItem(name, target, instructions, rest) {
  const item = document.createElement("article");
  item.className = "readonly-item";
  item.append(textEl("h4", name), textEl("p", target, "exercise-target"));
  if (rest) item.appendChild(textEl("p", `Recupero: ${rest}`, "exercise-rest"));
  if (instructions) {
    item.appendChild(textEl("p", instructions, "exercise-instructions"));
  }
  return item;
}
