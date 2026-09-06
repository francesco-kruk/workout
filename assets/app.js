async function boot() {
  const app = document.getElementById("workout-app");
  const loading = document.getElementById("loading");

  try {
    const plan = await loadPlan();
    loading.remove();
    renderWorkout(app, plan);
  } catch (error) {
    loading.textContent = "Non è stato possibile caricare il piano di allenamento.";
    loading.classList.add("error");
    console.error(error);
  }
}

boot();
