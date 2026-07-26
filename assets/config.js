// Repo configuration. Falls back to hardcoded values when not served from
// a <owner>.github.io/<repo>/ URL (e.g. local `python3 -m http.server`).
const FALLBACK_OWNER = "francesco-kruk";
const FALLBACK_REPO = "workout";
const BASE_BRANCH = "main";

function deriveRepoConfig() {
  const host = location.hostname; // "<owner>.github.io"
  const pathParts = location.pathname.split("/").filter(Boolean);

  if (host.endsWith(".github.io") && pathParts.length > 0) {
    return {
      owner: host.replace(".github.io", ""),
      repo: pathParts[0],
      branch: BASE_BRANCH,
    };
  }

  return { owner: FALLBACK_OWNER, repo: FALLBACK_REPO, branch: BASE_BRANCH };
}

const REPO_CONFIG = deriveRepoConfig();
const PLAN_PATH = "data/workout-plan.json";
const API_ROOT = "https://api.github.com";
