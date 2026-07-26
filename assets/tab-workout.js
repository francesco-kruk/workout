// Renders the read-only "Today" tab: current day, per-set checkboxes, and
// the "Workout Completed" button that advances to the next day.
function renderWorkoutTab(container, plan) {
  container.replaceChildren();

  const dayId = getCurrentDayId(plan);
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) {
    container.appendChild(textEl("p", "No workout day found."));
    return;
  }

  const progress = getProgress(day.id);

  const header = document.createElement("div");
  header.className = "day-header";
  header.appendChild(textEl("h2", day.label));
  header.appendChild(textEl("span", day.type, "day-type-badge"));
  container.appendChild(header);

  if (day.exercises.length === 0) {
    const restCard = document.createElement("div");
    restCard.className = "rest-card";
    restCard.appendChild(textEl("p", "Rest day. Recover well!"));
    container.appendChild(restCard);
  } else {
    const list = document.createElement("div");
    list.className = "exercise-list";
    for (const exercise of day.exercises) {
      list.appendChild(renderExerciseRow(day.id, exercise, progress));
    }
    container.appendChild(list);
  }

  const completeBtn = document.createElement("button");
  completeBtn.className = "btn btn-primary btn-complete";
  completeBtn.textContent = "Workout Completed";
  completeBtn.addEventListener("click", () => {
    const next = nextDayId(plan, day.id);
    setCurrentDayId(next);
    clearProgress(next);
    renderWorkoutTab(container, plan);
  });
  container.appendChild(completeBtn);
}

function renderExerciseRow(dayId, exercise, progress) {
  const row = document.createElement("div");
  row.className = "exercise-row";

  const info = document.createElement("div");
  info.className = "exercise-info";
  info.appendChild(textEl("div", exercise.name, "exercise-name"));

  const metaParts = [`${exercise.sets} x ${exercise.target}`];
  info.appendChild(textEl("div", metaParts.join(" "), "exercise-meta"));

  if (exercise.defaultValue) {
    info.appendChild(textEl("div", exercise.defaultValue, "exercise-default"));
  }
  row.appendChild(info);

  const checkboxes = document.createElement("div");
  checkboxes.className = "set-checkboxes";
  for (let i = 0; i < exercise.sets; i++) {
    const key = `${exercise.id}:${i}`;
    const label = document.createElement("label");
    label.className = "set-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(progress.checked[key]);
    input.addEventListener("change", () => {
      setChecked(dayId, key, input.checked);
    });
    label.appendChild(input);
    label.appendChild(textEl("span", String(i + 1)));
    checkboxes.appendChild(label);
  }
  row.appendChild(checkboxes);

  return row;
}

function textEl(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}
