(() => {
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) {
    throw new Error("The demo adapter can only run on localhost.");
  }
  const userId = "00000000-0000-4000-8000-000000000001";
  const key = "workout.preview.database";
  let database;
  let signedIn = true;
  let authChanged;
  let demoPassword = "Anteprima123!";
  const ok = (data) => ({ data, error: null });
  const persist = () => localStorage.setItem(key, JSON.stringify(database));
  const member = () => ({ user_id: userId, display_name: database.name });
  const session = () => signedIn ? { user: { id: userId, email: database.email } } : null;
  const friendId = "00000000-0000-4000-8000-000000000002";
  const thirdId = "00000000-0000-4000-8000-000000000003";
  function calendar() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type).value;
    const date = new Date(`${part("year")}-${part("month")}-${part("day")}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const week_start = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 7);
    return { week_start, settles_on: date.toISOString().slice(0, 10), month: `${part("year")}-${part("month")}-01` };
  }

  const banner = textEl("p", "Anteprima locale · account e classifica dimostrativi. Modifiche salvate solo in questo browser; nessun dato inviato al server. Password demo iniziale: Anteprima123! (ripristinata al ricaricamento). Non usare credenziali reali.", "social-panel preview-banner");
  document.body.prepend(banner);
  window.WORKOUT_SOCIAL_CONFIG = { url: "http://127.0.0.1", publishableKey: "local-preview-only" };

  window.loadSupabaseClient = async () => {
    const saved = localStorage.getItem(key);
    if (saved) database = JSON.parse(saved);
    else {
      const definition = await loadPlan();
      database = {
        name: "Tu", email: "demo@example.test", history: [],
        plans: [{ id: crypto.randomUUID(), user_id: userId, revision: 1, created_at: new Date().toISOString(), definition }],
      };
      persist();
    }
    database.email ||= "demo@example.test";
    if (!database.objectives) {
      const week = calendar();
      database.objectives = {
        cutover: week.week_start,
        proposals: [{
          id: crypto.randomUUID(), user_id: friendId, display_name: "Amico demo",
          rules: { count: { days: 3, bonus: 0.5 }, schedule: { days: [1, 6, 7], bonus: 0.5 } },
          electorate: [userId, thirdId], voter_names: { [userId]: database.name, [thirdId]: "Amica demo" },
          required_approvals: 2, status: "pending", effective_from: null,
          created_at: new Date().toISOString(),
          votes: [{ voter_id: thirdId, approve: true, created_at: new Date().toISOString() }],
        }],
      };
      persist();
    }
    const client = {
      auth: {
        getSession: async () => ok({ session: session() }),
        onAuthStateChange: (callback) => { authChanged = callback; },
        signOut: async () => { signedIn = false; return ok(null); },
        signInWithPassword: async ({ email, password }) => {
          if (email !== database.email || password !== demoPassword) {
            return { data: null, error: new Error("Usa l'email demo e la password demo indicata nel banner, oppure quella modificata in questa anteprima.") };
          }
          signedIn = true;
          authChanged?.("SIGNED_IN", session());
          return ok({ session: session() });
        },
        signUp: async () => {
          signedIn = true;
          authChanged?.("SIGNED_IN", session());
          return ok({ session: session() });
        },
        updateUser: async (attributes) => {
          if (!signedIn) return { data: null, error: new Error("Accedi all'anteprima.") };
          if (attributes.email) database.email = attributes.email;
          if (attributes.password) demoPassword = attributes.password;
          persist();
          authChanged?.("USER_UPDATED", session());
          return ok({ user: session().user });
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
          const week = calendar();
          return ok([
            { user_id: friendId, display_name: "Amico demo", points: 50, gym_days: 5, position: 1 },
            { user_id: userId, display_name: database.name, points: 30, gym_days: 3, position: 2 },
            { user_id: thirdId, display_name: "Amica demo", points: 20, gym_days: 2, position: 3 },
          ].map((row) => ({
            ...row, month_start: week.month, week_start: week.week_start, settles_on: week.settles_on,
            cutover: database.objectives.cutover, weekly_streak: 1, settled_multiplier: 1,
            week_days: [1], pending_bonus: 0, current_bonuses: { streak: 0, count: 0, schedule: 0 },
            current_streak: 0, multiplier: 1,
          })));
        }
        if (name === "ranking_objectives") {
          return ok(structuredClone({ ...database.objectives, ...calendar() }));
        }
        if (name === "propose_ranking_objectives") {
          const error = validateRankingObjectives(args.p_rules);
          if (error) throw new Error(error);
          const existing = database.objectives.proposals.find((p) => p.id === args.p_id);
          if (existing) {
            if (existing.user_id === userId && JSON.stringify(existing.rules) === JSON.stringify(args.p_rules)) return ok(existing.id);
            throw new Error("Identificativo proposta già usato.");
          }
          if (database.objectives.proposals.some((p) => p.user_id === userId &&
            (p.status === "pending" || p.status === "approved" && p.effective_from > calendar().week_start))) {
            throw new Error("Hai già una proposta in attesa o approvata per la prossima settimana.");
          }
          database.objectives.proposals.unshift({
            id: args.p_id, user_id: userId, display_name: database.name, rules: structuredClone(args.p_rules),
            electorate: [friendId, thirdId], voter_names: { [friendId]: "Amico demo", [thirdId]: "Amica demo" },
            required_approvals: 2, status: "pending", effective_from: null,
            created_at: new Date().toISOString(), votes: [],
          });
          persist();
          return ok(args.p_id);
        }
        if (name === "vote_ranking_objectives" || name === "withdraw_ranking_objectives") {
          const proposal = database.objectives.proposals.find((p) => p.id === args.p_id);
          if (!proposal) throw new Error("Proposta non trovata.");
          if (name === "withdraw_ranking_objectives") {
            if (proposal.user_id !== userId) throw new Error("Solo il proponente può ritirare.");
            if (proposal.status === "withdrawn") return ok("withdrawn");
            if (proposal.status !== "pending") throw new Error("La proposta non è più in votazione.");
            proposal.status = "withdrawn";
          } else {
            if (!proposal.electorate.includes(userId)) throw new Error("Non puoi votare questa proposta.");
            const previous = proposal.votes.find((vote) => vote.voter_id === userId);
            if (previous) {
              if (previous.approve === args.p_approve) return ok(proposal.status);
              throw new Error("Il voto non è modificabile.");
            }
            if (proposal.status !== "pending") throw new Error("La proposta non è più in votazione.");
            proposal.votes.push({ voter_id: userId, approve: args.p_approve, created_at: new Date().toISOString() });
            const approvals = proposal.votes.filter((vote) => vote.approve).length;
            const rejections = proposal.votes.filter((vote) => !vote.approve).length;
            if (approvals >= proposal.required_approvals) {
              proposal.status = "approved";
              proposal.effective_from = calendar().settles_on;
            } else if (proposal.electorate.length - rejections < proposal.required_approvals) proposal.status = "rejected";
          }
          proposal.decided_at = proposal.status === "pending" ? null : new Date().toISOString();
          persist();
          return ok(proposal.status);
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
