(() => {
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) {
    throw new Error("The demo adapter can only run on localhost.");
  }
  const userId = "00000000-0000-4000-8000-000000000001";
  const key = "workout.preview.database";
  let database;
  let signedIn = true;
  let authChanged;
  const ok = (data) => ({ data, error: null });
  const persist = () => localStorage.setItem(key, JSON.stringify(database));
  const member = () => ({ user_id: userId, display_name: database.name });
  const session = () => signedIn ? { user: { id: userId } } : null;

  const banner = textEl("p", "Anteprima locale · account e classifica dimostrativi. Modifiche salvate solo in questo browser; nessun dato inviato al server.", "social-panel");
  document.querySelector(".app-header").prepend(banner);
  window.WORKOUT_SOCIAL_CONFIG = { url: "http://127.0.0.1", publishableKey: "local-preview-only" };

  window.loadSupabaseClient = async () => {
    const saved = localStorage.getItem(key);
    if (saved) database = JSON.parse(saved);
    else {
      const definition = await loadPlan();
      database = {
        name: "Tu", history: [],
        plans: [{ id: crypto.randomUUID(), user_id: userId, revision: 1, created_at: new Date().toISOString(), definition }],
      };
      persist();
    }
    const client = {
      auth: {
        getSession: async () => ok({ session: session() }),
        onAuthStateChange: (callback) => { authChanged = callback; },
        signOut: async () => { signedIn = false; return ok(null); },
        signInWithPassword: async () => {
          signedIn = true;
          authChanged?.("SIGNED_IN", session());
          return ok({ session: session() });
        },
        signUp: async () => {
          signedIn = true;
          authChanged?.("SIGNED_IN", session());
          return ok({ session: session() });
        },
      },
      from: (table) => {
        let updates;
        const read = () => {
          if (!signedIn) throw new Error("Accedi all'anteprima.");
          if (table === "friend_members") {
            if (updates) { database.name = updates.display_name; persist(); }
            return ok(member());
          }
          if (table === "workout_plan_versions") return ok(database.plans.at(-1) || null);
          throw new Error(`Unsupported preview table: ${table}`);
        };
        const chain = {
          select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
          update: (value) => { updates = value; return chain; },
          single: async () => read(), maybeSingle: async () => read(),
        };
        return chain;
      },
      rpc: async (name, args = {}) => {
        if (!signedIn) throw new Error("Accedi all'anteprima.");
        if (name === "friends_leaderboard") {
          const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).formatToParts(new Date());
          const month = `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
          return ok([
            { user_id: "demo-friend", display_name: "Amico demo", points: 70, gym_days: 5, current_streak: 3, multiplier: 1.5, position: 1, month_start: `${month}-01` },
            { user_id: userId, display_name: database.name, points: 35, gym_days: 3, current_streak: 2, multiplier: 1.25, position: 2, month_start: `${month}-01` },
          ]);
        }
        if (name === "save_workout_plan") {
          const errors = validateWorkoutPlan(args.p_definition);
          if (errors.length) return { data: null, error: new Error(errors.join("\n")) };
          if (args.p_base_version_id !== (database.plans.at(-1)?.id || null)) {
            return { data: null, error: new Error("Il piano è cambiato. Ricarica l'anteprima prima di salvare.") };
          }
          const record = {
            id: args.p_version_id, user_id: userId, revision: database.plans.length + 1,
            created_at: new Date().toISOString(), definition: structuredClone(args.p_definition),
          };
          database.plans.push(record);
          persist();
          return ok(record);
        }
        if (name === "submit_workout_result") {
          const plan = database.plans.find((record) => record.id === args.p_plan_version_id);
          const day = plan?.definition.sessions.find((item) => item.id === args.p_session_id);
          if (!plan || !day) throw new Error("Piano di anteprima non disponibile.");
          if (!database.history.some((result) => result.id === args.p_event_id)) {
            database.history.push({
              id: args.p_event_id, completed_at: args.p_completed_at, plan_version_id: plan.id,
              revision: plan.revision, plan_title: plan.definition.title, warmup: plan.definition.warmup,
              session: day, steps: args.p_steps, amrap_rounds: args.p_amrap_rounds,
            });
            persist();
          }
          return ok("local-preview");
        }
        if (name === "workout_history") {
          const rows = [...database.history].sort((a, b) => b.completed_at.localeCompare(a.completed_at) || b.id.localeCompare(a.id));
          const cursor = args.p_before_id ? rows.findIndex((row) => row.id === args.p_before_id) + 1 : 0;
          return ok(rows.slice(cursor, cursor + 20));
        }
        throw new Error(`Unsupported preview RPC: ${name}`);
      },
    };
    return { createClient: () => client };
  };
})();
