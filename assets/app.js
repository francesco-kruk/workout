function boot() {
  const app = document.getElementById("workout-app");
  const loading = document.getElementById("loading");
  const nav = document.querySelector(".app-nav");
  const navButtons = [...nav.querySelectorAll("[data-view]")];
  const header = document.querySelector(".app-header");
  const config = window.WORKOUT_SOCIAL_CONFIG || {};
  const configured = Boolean(config.url && config.publishableKey);
  let cleanupView = null;
  let screen = "";
  let templateLoaded = false;
  let templateError = "";

  function updateAccountStatus() {
    const status = document.getElementById("account-status");
    const library = window.workoutLibrary.snapshot();
    const social = window.workoutSocial.snapshot();
    if (status) {
      status.textContent = screen.startsWith("app:") ? library.error || social.error || library.notice || social.notice || "" : "";
      status.hidden = !status.textContent;
      status.classList.toggle("error", Boolean(library.error || social.error));
    }
  }

  function accessScreen() {
    const social = window.workoutSocial.snapshot();
    const library = window.workoutLibrary.snapshot();
    if (!configured) return templateLoaded ? "app:local" : "loading";
    if (!social.ready) return "loading";
    if (!social.user) return "sign-in";
    if (library.userId !== social.user.id || !social.accessReady) {
      return social.error && !social.busy ? "access-error" : "loading";
    }
    if (!social.member) return "pending";
    if (!library.record && screen !== `app:${social.user.id}`) {
      if (library.loading) return "loading";
      if (library.error) return "plan-error";
    }
    return `app:${social.user.id}`;
  }

  function renderView() {
    cleanupView?.();
    cleanupView = null;
    const activeView = getActiveView();
    const library = window.workoutLibrary.snapshot();
    updateAccountStatus();
    for (const button of navButtons) {
      const selected = button.dataset.view === activeView;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
    }
    if (activeView === "plan") {
      cleanupView = renderPersonalPlan(app);
    } else if (activeView === "profile") {
      cleanupView = renderProfile(app);
    } else if (!library.plan) {
      app.replaceChildren(
        textEl("h2", "La tua scheda"),
        textEl("p", templateError || "Crea o importa la tua scheda nella tab Piano.", "view-description")
      );
      const openPlan = createButton("Apri Piano", "btn btn-primary");
      openPlan.addEventListener("click", () => { setActiveView("plan"); renderView(); });
      app.appendChild(openPlan);
    } else if (activeView === "workout") {
      cleanupView = renderWorkout(app, library.plan, renderView);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function reconcile(force = false) {
    const next = accessScreen();
    const changed = next !== screen;
    if (changed) {
      cleanupView?.();
      cleanupView = null;
      screen = next;
      loading?.remove();
      nav.hidden = !screen.startsWith("app:");
      if (header) header.hidden = !nav.hidden;
      document.body.classList.toggle("auth-entry", nav.hidden);
      if (!nav.hidden && configured && !window.workoutLibrary.snapshot().record) setActiveView("plan");
    }
    updateAccountStatus();
    if (screen.startsWith("app:")) {
      if (changed || force) renderView();
    } else if (changed || !cleanupView) {
      cleanupView = renderAuthEntry(app, screen);
    }
  }

  nav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button || nav.hidden) return;
    setActiveView(button.dataset.view);
    renderView();
  });
  window.addEventListener("workout-library-will-change", () => {
    cleanupView?.();
    cleanupView = null;
  });
  window.addEventListener("workout-library-change", () => reconcile(true));
  window.addEventListener("workout-social-change", () => reconcile());
  window.addEventListener("workout-library-status", () => reconcile());

  window.workoutLibrary.start(null);
  reconcile();
  void window.workoutSocial.init();
  void (async () => {
    let template = null;
    try {
      template = await loadPlan();
    } catch (error) {
      console.error("Scheda di esempio non disponibile.", error);
      templateError = "Scheda di esempio non disponibile.";
    }
    templateLoaded = true;
    try {
      window.workoutLibrary.start(template);
    } catch (error) {
      window.workoutSocial.reportError(error, "Preparazione dei progressi locali non riuscita.");
    }
    reconcile(!configured);
  })();
}

boot();
