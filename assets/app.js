async function boot() {
  const app = document.getElementById("workout-app");
  const loading = document.getElementById("loading");
  const nav = document.querySelector(".app-nav");
  const navButtons = [...nav.querySelectorAll("[data-view]")];
  let cleanupView = null;

  try {
    const plan = await loadPlan();
    loading.remove();

    function renderView() {
      cleanupView?.();
      cleanupView = null;

      const activeView = getActiveView();
      for (const button of navButtons) {
        const selected = button.dataset.view === activeView;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-current", selected ? "page" : "false");
      }

      if (activeView === "plan") {
        renderPlan(app, plan);
      } else if (activeView === "workout") {
        cleanupView = renderWorkout(app, plan, renderView);
      } else {
        renderDay(app, plan);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    nav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-view]");
      if (!button) return;
      setActiveView(button.dataset.view);
      renderView();
    });

    renderView();
  } catch (error) {
    loading.textContent = "Non è stato possibile caricare il piano di allenamento.";
    loading.classList.add("error");
    console.error(error);
  }
}

boot();
