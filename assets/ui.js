function textEl(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function createProgress(summary, label = "attività obbligatorie") {
  const wrap = document.createElement("div");
  wrap.className = "progress-wrap";

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(summary.percentage));

  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.style.width = `${summary.percentage}%`;
  bar.appendChild(fill);

  const progressLabel = textEl(
    "span",
    `${summary.completedRequired} di ${summary.required.length} ${label}`,
    "progress-label"
  );
  wrap.append(bar, progressLabel);
  return wrap;
}

function createSessionHeading(session, eyebrow) {
  const fragment = document.createDocumentFragment();
  if (eyebrow) fragment.appendChild(textEl("p", eyebrow, "cycle-label"));

  const heading = document.createElement("div");
  heading.className = "session-heading";
  heading.appendChild(textEl("h2", session.label));
  if (session.subtitle) {
    heading.appendChild(textEl("span", session.subtitle, "session-badge"));
  }
  fragment.appendChild(heading);
  return fragment;
}

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
