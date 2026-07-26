// App bootstrap: tab switching, settings panel, token expiry banner.
let currentPlan = null;

async function boot() {
  const workoutTabEl = document.getElementById("tab-workout");
  const manageTabEl = document.getElementById("tab-manage");
  const loadingEl = document.getElementById("loading");

  try {
    currentPlan = await loadPlan();
  } catch (err) {
    loadingEl.textContent = "Failed to load workout plan.";
    console.error(err);
    return;
  }

  loadingEl.hidden = true;
  renderWorkoutTab(workoutTabEl, currentPlan);
  renderManageTab(manageTabEl, currentPlan);

  setupTabSwitching();
  setupSettingsPanel();
  await refreshTokenBanner();
}

function setupTabSwitching() {
  const buttons = document.querySelectorAll(".tab-button");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = true));
      document.getElementById(btn.dataset.target).hidden = false;
    });
  });
}

function setupSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  const openBtn = document.getElementById("settings-toggle");
  const tokenInput = document.getElementById("token-input");
  const saveBtn = document.getElementById("token-save");
  const clearBtn = document.getElementById("token-clear");
  const testStatus = document.getElementById("token-test-status");

  tokenInput.value = getToken();

  openBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });

  saveBtn.addEventListener("click", async () => {
    setToken(tokenInput.value.trim());
    testStatus.textContent = "Checking token…";
    const valid = await checkTokenValid();
    testStatus.textContent = valid === true ? "Token is valid." : valid === false ? "Token was rejected." : "Could not verify token right now.";
    await refreshTokenBanner();
    renderManageTab(document.getElementById("tab-manage"), currentPlan);
  });

  clearBtn.addEventListener("click", async () => {
    setToken("");
    tokenInput.value = "";
    testStatus.textContent = "Token cleared.";
    await refreshTokenBanner();
    renderManageTab(document.getElementById("tab-manage"), currentPlan);
  });
}

async function refreshTokenBanner() {
  const banner = document.getElementById("token-banner");
  const valid = await checkTokenValid();
  if (valid === false) {
    banner.hidden = false;
    banner.replaceChildren();
    banner.appendChild(document.createTextNode("GitHub token expired or revoked — "));
    const link = document.createElement("button");
    link.className = "link-button";
    link.textContent = "re-enter it in Settings";
    link.addEventListener("click", () => {
      document.getElementById("settings-panel").hidden = false;
    });
    banner.appendChild(link);
  } else {
    banner.hidden = true;
  }
}

boot();
