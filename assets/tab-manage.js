// Renders the full-CRUD "Manage" tab. Works on an in-memory deep clone;
// tracks dirtiness for the beforeunload guard and the Submit button state.
let manageWorkingPlan = null;
let manageDirty = false;

function renderManageTab(container, plan) {
  manageWorkingPlan = structuredClone(plan);
  manageDirty = false;
  renderManageBody(container);
}

function markDirty(container) {
  manageDirty = true;
  renderManageBody(container);
}

function renderManageBody(container) {
  container.replaceChildren();

  if (manageDirty) {
    container.appendChild(textEl("div", "You have unsaved changes.", "dirty-banner"));
  }

  const daysWrap = document.createElement("div");
  daysWrap.className = "manage-days";
  manageWorkingPlan.days.forEach((day, dayIdx) => {
    daysWrap.appendChild(renderManageDay(container, day, dayIdx));
  });
  container.appendChild(daysWrap);

  const addDayBtn = document.createElement("button");
  addDayBtn.className = "btn btn-secondary";
  addDayBtn.textContent = "Add day";
  addDayBtn.addEventListener("click", () => {
    manageWorkingPlan.days.push({
      id: crypto.randomUUID(),
      label: `Day ${manageWorkingPlan.days.length + 1}`,
      type: "Push",
      exercises: [],
    });
    markDirty(container);
  });
  container.appendChild(addDayBtn);

  const submitSection = document.createElement("div");
  submitSection.className = "submit-section";
  const status = textEl("div", "", "submit-status");
  const submitBtn = document.createElement("button");
  submitBtn.className = "btn btn-primary";
  submitBtn.textContent = "Submit changes";
  submitBtn.disabled = !manageDirty || !getToken();
  if (!getToken()) {
    status.textContent = "Add a GitHub token in Settings to submit changes.";
  }
  submitBtn.addEventListener("click", async () => {
    const errors = validatePlan(manageWorkingPlan);
    if (errors.length > 0) {
      status.textContent = `Fix before submitting: ${errors.join("; ")}`;
      return;
    }
    submitBtn.disabled = true;
    status.textContent = "Submitting changes…";
    try {
      const prUrl = await submitPlanChanges(manageWorkingPlan, "Workout plan changes submitted from the management UI.");
      manageDirty = false;
      status.replaceChildren();
      status.appendChild(textEl("span", "Pull request created: "));
      const link = document.createElement("a");
      link.href = prUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = prUrl;
      status.appendChild(link);
    } catch (err) {
      console.error(err);
      if (err.status === 401) {
        status.textContent = "Your GitHub token was rejected. Re-enter it in Settings.";
      } else {
        status.textContent = `Submit failed: ${err.message}`;
      }
      submitBtn.disabled = false;
    }
  });
  submitSection.appendChild(submitBtn);
  submitSection.appendChild(status);
  container.appendChild(submitSection);
}

function validatePlan(plan) {
  const errors = [];
  if (!plan.days || plan.days.length === 0) {
    errors.push("plan must have at least one day");
  }
  const ids = new Set();
  for (const day of plan.days || []) {
    if (!day.label || !day.label.trim()) errors.push("a day is missing a label");
    if (ids.has(day.id)) errors.push("duplicate day id");
    ids.add(day.id);
    for (const ex of day.exercises || []) {
      if (!ex.name || !ex.name.trim()) errors.push(`an exercise in ${day.label} is missing a name`);
      if (!Number.isInteger(ex.sets) || ex.sets < 1) errors.push(`${ex.name || "exercise"} must have sets >= 1`);
      if (ids.has(ex.id)) errors.push("duplicate exercise id");
      ids.add(ex.id);
    }
  }
  return errors;
}

function renderManageDay(container, day, dayIdx) {
  const card = document.createElement("div");
  card.className = "manage-day-card";

  const header = document.createElement("div");
  header.className = "manage-day-header";

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.value = day.label;
  labelInput.className = "input day-label-input";
  labelInput.addEventListener("input", () => {
    day.label = labelInput.value;
    manageDirty = true;
  });
  header.appendChild(labelInput);

  const typeSelect = document.createElement("select");
  typeSelect.className = "input day-type-select";
  const types = ["Push", "Pull", "Legs", "Cardio", "Rest"];
  if (!types.includes(day.type)) types.push(day.type);
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    if (t === day.type) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener("change", () => {
    day.type = typeSelect.value;
    markDirty(container);
  });
  header.appendChild(typeSelect);

  const deleteDayBtn = document.createElement("button");
  deleteDayBtn.className = "btn btn-danger";
  deleteDayBtn.textContent = "Delete day";
  deleteDayBtn.addEventListener("click", () => {
    if (!confirm(`Delete ${day.label}? This cannot be undone.`)) return;
    manageWorkingPlan.days.splice(dayIdx, 1);
    markDirty(container);
  });
  header.appendChild(deleteDayBtn);

  card.appendChild(header);

  const exList = document.createElement("div");
  exList.className = "manage-exercise-list";
  day.exercises.forEach((ex, exIdx) => {
    exList.appendChild(renderManageExercise(container, day, ex, exIdx));
  });
  card.appendChild(exList);

  const addExBtn = document.createElement("button");
  addExBtn.className = "btn btn-secondary";
  addExBtn.textContent = "Add exercise";
  addExBtn.addEventListener("click", () => {
    day.exercises.push({
      id: crypto.randomUUID(),
      name: "New exercise",
      sets: 3,
      target: "8/10",
      defaultValue: "",
    });
    markDirty(container);
  });
  card.appendChild(addExBtn);

  return card;
}

function renderManageExercise(container, day, exercise, exIdx) {
  const row = document.createElement("div");
  row.className = "manage-exercise-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "input ex-name-input";
  nameInput.value = exercise.name;
  nameInput.placeholder = "Name";
  nameInput.addEventListener("input", () => {
    exercise.name = nameInput.value;
    manageDirty = true;
  });
  row.appendChild(nameInput);

  const setsInput = document.createElement("input");
  setsInput.type = "number";
  setsInput.min = "1";
  setsInput.className = "input ex-sets-input";
  setsInput.value = String(exercise.sets);
  setsInput.addEventListener("input", () => {
    exercise.sets = parseInt(setsInput.value, 10) || 1;
    manageDirty = true;
  });
  row.appendChild(setsInput);

  const targetInput = document.createElement("input");
  targetInput.type = "text";
  targetInput.className = "input ex-target-input";
  targetInput.value = exercise.target;
  targetInput.placeholder = "Target";
  targetInput.addEventListener("input", () => {
    exercise.target = targetInput.value;
    manageDirty = true;
  });
  row.appendChild(targetInput);

  const defaultInput = document.createElement("input");
  defaultInput.type = "text";
  defaultInput.className = "input ex-default-input";
  defaultInput.value = exercise.defaultValue;
  defaultInput.placeholder = "Default value";
  defaultInput.addEventListener("input", () => {
    exercise.defaultValue = defaultInput.value;
    manageDirty = true;
  });
  row.appendChild(defaultInput);

  const upBtn = document.createElement("button");
  upBtn.className = "btn btn-icon";
  upBtn.textContent = "↑";
  upBtn.disabled = exIdx === 0;
  upBtn.addEventListener("click", () => {
    swapExercises(day, exIdx, exIdx - 1);
    markDirty(container);
  });
  row.appendChild(upBtn);

  const downBtn = document.createElement("button");
  downBtn.className = "btn btn-icon";
  downBtn.textContent = "↓";
  downBtn.disabled = exIdx === day.exercises.length - 1;
  downBtn.addEventListener("click", () => {
    swapExercises(day, exIdx, exIdx + 1);
    markDirty(container);
  });
  row.appendChild(downBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn-danger btn-icon";
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", () => {
    day.exercises.splice(exIdx, 1);
    markDirty(container);
  });
  row.appendChild(deleteBtn);

  return row;
}

function swapExercises(day, i, j) {
  [day.exercises[i], day.exercises[j]] = [day.exercises[j], day.exercises[i]];
}

window.addEventListener("beforeunload", (e) => {
  if (manageDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
