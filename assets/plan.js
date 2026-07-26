// Loads the canonical plan. Prefers the GitHub Contents API (always fresh,
// bypasses the ~10 min Pages CDN cache); falls back to a cache-busted
// relative fetch if the API call fails (rate limit, offline, etc.).
async function loadPlan() {
  try {
    return await loadPlanFromApi();
  } catch (err) {
    console.warn("Falling back to static fetch for plan:", err);
    return await loadPlanFromStatic();
  }
}

async function loadPlanFromApi() {
  const { owner, repo, branch } = REPO_CONFIG;
  const url = `${API_ROOT}/repos/${owner}/${repo}/contents/${PLAN_PATH}?ref=${branch}`;
  const headers = { Accept: "application/vnd.github.raw+json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Contents API failed: ${res.status}`);
  const text = await res.text();
  return JSON.parse(text);
}

async function loadPlanFromStatic() {
  const res = await fetch(`./${PLAN_PATH}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Static fetch failed: ${res.status}`);
  return res.json();
}
