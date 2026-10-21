async function boot() {
  const app = document.getElementById("workout-app");
  const loading = document.getElementById("loading");
  const nav = document.querySelector(".app-nav");
  const navButtons = [...nav.querySelectorAll("[data-view]")];
  let cleanupView = null;
  let templateError = "";
  function updateAccountStatus() {
    const status = document.getElementById("account-status");
    if (!status) return;
    const state = window.workoutLibrary.snapshot();
    status.textContent = state.error || window.workoutSocial.snapshot().error || state.notice || (state.userId
      ? state.loading ? "Caricamento scheda personale..." : state.record ? `Scheda personale · versione ${state.record.revision}` : "Nessuna scheda personale caricata."
      : "Modalità esempio · accedi dalla Classifica per la tua scheda privata.");
  }

  const callback = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  if (callback.has("access_token") || callback.has("error") || query.has("code") || query.has("error")) {
    setActiveView("leaderboard");
  }

  try {
    let defaultPlan = null;
    try {
      defaultPlan = await loadPlan();
    } catch (error) {
      console.error("Scheda di esempio non disponibile.", error);
      templateError = "Scheda di esempio non disponibile. Accedi per caricare la tua scheda personale.";
    }
    try {
      window.workoutLibrary.start(defaultPlan);
    } catch (error) {
      window.workoutSocial.reportError(error, "Preparazione dei progressi locali non riuscita.");
    }
    loading.remove();

    function renderView() {
      cleanupView?.();
      cleanupView = null;

      const activeView = getActiveView();
      const library = window.workoutLibrary.snapshot();
      updateAccountStatus();
      const plan = library.plan;
      for (const button of navButtons) {
        const selected = button.dataset.view === activeView;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-current", selected ? "page" : "false");
      }

      if (activeView === "plan") {
        cleanupView = renderPersonalPlan(app);
      } else if (activeView === "leaderboard") {
        cleanupView = renderLeaderboard(app);
      } else if (!plan) {
        app.replaceChildren(
          textEl("h2", library.loading ? "Caricamento scheda..." : "La tua scheda"),
          textEl("p", library.error || templateError || "Crea o importa la tua scheda nella tab Piano. Accedi prima dalla Classifica.", "view-description")
        );
        const openPlan = createButton("Apri Piano", "btn btn-primary");
        openPlan.addEventListener("click", () => { setActiveView("plan"); renderView(); });
        app.appendChild(openPlan);
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

    window.addEventListener("workout-library-will-change", () => {
      cleanupView?.();
      cleanupView = null;
    });
    window.addEventListener("workout-library-change", renderView);
    window.addEventListener("workout-social-change", updateAccountStatus);
    window.addEventListener("workout-library-status", () => {
      updateAccountStatus();
      if (!window.workoutLibrary.snapshot().plan && !["plan", "leaderboard"].includes(getActiveView())) renderView();
    });
    renderView();
  } catch (error) {
    const target = loading.isConnected ? loading : app;
    target.textContent = "Non è stato possibile caricare l'app di allenamento.";
    target.classList.add("error");
    console.error(error);
  }
}

boot();
void window.workoutSocial.init();
