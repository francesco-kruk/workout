// All GitHub write operations live here. This is the only module that reads
// the token from state.js. Never log the token or embed it in any URL body.

function utf8ToBase64(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

async function githubRequest(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${path} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Returns true/false; never throws. Used for the boot-time expiry banner.
async function checkTokenValid() {
  const token = getToken();
  if (!token) return null; // no token saved - not an "expired" state
  try {
    await githubRequest("/user");
    return true;
  } catch (err) {
    if (err.status === 401) return false;
    // Network error or rate limit: treat as unknown, don't show the expiry banner.
    return null;
  }
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Creates a branch with the updated plan JSON and opens a PR into main.
// Returns the PR html_url on success.
async function submitPlanChanges(plan, summary) {
  const { owner, repo, branch: baseBranch } = REPO_CONFIG;
  const branchName = `plan-update-${timestampSlug()}`;
  const content = JSON.stringify(plan, null, 2) + "\n";

  const baseRef = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`);
  const baseSha = baseRef.object.sha;

  try {
    await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });
  } catch (err) {
    if (err.status === 422) {
      throw new Error("A branch with that name already exists. Please try again.");
    }
    throw err;
  }

  const existingFile = await githubRequest(
    `/repos/${owner}/${repo}/contents/${PLAN_PATH}?ref=${baseBranch}`
  );

  await githubRequest(`/repos/${owner}/${repo}/contents/${PLAN_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update workout plan",
      content: utf8ToBase64(content),
      branch: branchName,
      sha: existingFile.sha,
    }),
  });

  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `Workout plan update - ${timestampSlug()}`,
      head: branchName,
      base: baseBranch,
      body: summary || "Workout plan changes submitted from the management UI.",
    }),
  });

  return pr.html_url;
}
