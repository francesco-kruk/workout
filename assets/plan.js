const PLAN_PATH = "data/workout-plan.json";

async function loadPlan() {
  const response = await fetch(`./${PLAN_PATH}?v=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`Caricamento del piano non riuscito: ${response.status}`);
  }
  const plan = await response.json();
  const errors = validateWorkoutPlan(plan);
  if (errors.length) throw new Error(errors.join("\n"));
  return plan;
}
