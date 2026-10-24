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
  const dateLabel = (date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
  function seriesKey(plan, day, exercise = null) {
    const identity = JSON.stringify([plan.trackingId || "legacy", day.type, exercise
      ? [exercise.id, exercise.name, exercise.instructions || ""]
      : [day.id, parseInt(day.duration, 10), day.instructions || "",
        day.exercises.map((e) => [e.id, e.name, e.target, e.instructions || ""])]]);
    database.seriesKeys ||= {};
    if (!database.seriesKeys[identity]) database.seriesKeys[identity] = crypto.randomUUID().replaceAll("-", "");
    return database.seriesKeys[identity];
  }
  function entries() {
    return database.history.flatMap((row) => {
      const plan = database.plans.find((p) => p.id === row.plan_version_id)?.definition;
      if (!plan) throw new Error("Definizione storica di anteprima non disponibile.");
      const day = row.session;
      if (day.type === "amrap") return [{
        id: row.id, completed_at: row.completed_at, series_key: seriesKey(plan, day),
        name: day.subtitle || day.label, context: day.duration, kind: "amrap",
        sets: [], rounds: row.amrap_rounds, extra_reps: row.amrap_extra_reps ?? null,
        max_weight: null, max_reps: null, max_seconds: null,
      }];
      return day.exercises.flatMap((e) => {
        const sets = Array.from({ length: e.sets + (e.optionalSets || 0) }, (_, index) => {
          const value = row.measurements?.[`${e.id}:${index}`];
          return value ? { set: index + 1, ...value } : null;
        }).filter(Boolean);
        if (!sets.length) return [];
        const max = (key) => {
          const values = sets.map((s) => s[key]).filter((v) => v != null);
          return values.length ? Math.max(...values) : null;
        };
        return [{
          id: row.id, completed_at: row.completed_at, series_key: seriesKey(plan, day, e),
          name: e.name, context: day.label, kind: "standard", sets,
          rounds: null, extra_reps: null,
          max_weight: max("weightKg"), max_reps: max("reps"), max_seconds: max("seconds"),
        }];
      });
    }).sort((a, b) => b.completed_at.localeCompare(a.completed_at) || b.id.localeCompare(a.id));
  }

  const banner = textEl("p", "Anteprima locale · account, voti e classifica dimostrativi. La classifica non ricalcola i punti. Modifiche salvate solo in questo browser; nessun dato inviato al server. Password demo iniziale: Anteprima123! (ripristinata al ricaricamento). Non usare credenziali reali.", "social-panel preview-banner");
  document.body.prepend(banner);
  window.WORKOUT_SOCIAL_CONFIG = { url: "http://127.0.0.1", publishableKey: "local-preview-only" };

  window.loadSupabaseClient = async () => {
    const saved = localStorage.getItem(key);
    if (saved) database = JSON.parse(saved);
    else {
      const definition = await loadPlan();
      definition.trackingId = "demo-plan";
      const created = new Date(Date.now() - 30 * 86400000).toISOString();
      const plan = { id: crypto.randomUUID(), user_id: userId, revision: 1, created_at: created, definition };
      database = { name: "Tu", email: "demo@example.test", history: [], plans: [plan] };
      for (const [index, age] of [21, 14, 7].entries()) {
        for (const day of [definition.sessions.find((d) => d.type === "standard"), definition.sessions.find((d) => d.type === "amrap")].filter(Boolean)) {
          const measurements = {};
          if (day.type === "standard") day.exercises.slice(0, 2).forEach((e, exerciseIndex) => {
            for (let set = 0; set < e.sets; set += 1) {
              measurements[`${e.id}:${set}`] = exerciseIndex === 0
                ? { seconds: 15 + index * 5 } : { weightKg: 20 + index * 2, reps: 8 };
            }
          });
          database.history.push({
            id: crypto.randomUUID(), plan_version_id: plan.id,
            completed_at: new Date(Date.now() - age * 86400000).toISOString(),
            revision: 1, plan_title: definition.title, warmup: definition.warmup, session: day,
            steps: Object.fromEntries(getWorkoutSteps(definition, day).map((s) => [s.key, "completed"])),
            measurements, amrap_rounds: day.type === "amrap" ? 3 + index : null,
            amrap_extra_reps: day.type === "amrap" ? 2 + index : null,
          });
        }
      }
      persist();
    }
    database.email ||= "demo@example.test";
    if (!database.manualWorkouts) {
      database.manualWorkouts = [{
        id: crypto.randomUUID(), user_id: "00000000-0000-4000-8000-000000000002",
        display_name: "Amico demo", description: "Esempio demo: corsa di 5 km al parco.",
        replaces_planned: false, completed_at: new Date().toISOString(), status: "pending",
        decided_at: null, reason: null, voters: 2, required_approvals: 2,
        approvals: 1, rejections: 0, own_vote: null, eligible: true,
      }];
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
        if (name === "submit_manual_workout") {
          const existing = database.manualWorkouts.find((row) => row.id === args.p_id);
          if (existing) {
            if (existing.description !== args.p_description.trim()
              || existing.replaces_planned !== args.p_replaces_planned
              || existing.plan_version_id !== args.p_plan_version_id || existing.session_id !== args.p_session_id) {
              throw new Error("Submission ID already used");
            }
            return ok(existing);
          }
          const plan = database.plans.find((p) => p.id === args.p_plan_version_id);
          if (!plan?.definition.sessions.some((s) => s.id === args.p_session_id)
            || !args.p_description.trim() || args.p_description.trim().length > 2000
            || typeof args.p_replaces_planned !== "boolean") {
            throw new Error("Invio manuale non valido.");
          }
          const row = {
            id: args.p_id, user_id: userId, display_name: database.name,
            plan_version_id: args.p_plan_version_id, session_id: args.p_session_id,
            description: args.p_description.trim(), replaces_planned: args.p_replaces_planned,
            completed_at: new Date().toISOString(), status: "pending", decided_at: null,
            reason: null, voters: 2, required_approvals: 2, approvals: 0, rejections: 0, own_vote: null, eligible: false,
          };
          database.manualWorkouts.push(row);
          persist();
          return ok(row);
        }
        if (name === "manual_workout_activity") {
          const rows = database.manualWorkouts.filter((row) => args.p_own
            ? row.user_id === userId : row.eligible && row.status === "pending" && row.own_vote === null)
            .sort((a, b) => b.completed_at.localeCompare(a.completed_at) || b.id.localeCompare(a.id));
          const cursor = args.p_before_id ? rows.findIndex((row) => row.id === args.p_before_id) + 1 : 0;
          return ok(rows.slice(cursor, cursor + 20).map(({ plan_version_id, session_id, ...row }) =>
            ({ ...row, display_name: row.user_id === userId ? database.name : row.display_name })));
        }
        if (name === "vote_manual_workout") {
          const row = database.manualWorkouts.find((row) => row.id === args.p_id);
          if (!row?.eligible || row.user_id === userId) throw new Error("Not eligible to vote");
          if (row.own_vote !== null) {
            if (row.own_vote !== args.p_approve) throw new Error("Votes cannot be changed");
            return ok(row);
          }
          if (row.status !== "pending") throw new Error("Review is no longer pending");
          row.own_vote = args.p_approve;
          if (args.p_approve) row.approvals += 1;
          else row.rejections += 1;
          if (row.approvals >= row.required_approvals) row.status = "approved";
          else if (row.voters - row.rejections < row.required_approvals) row.status = "rejected";
          if (row.status !== "pending") row.decided_at = new Date().toISOString();
          persist();
          return ok(row);
        }
        if (name === "friends_leaderboard") {
          const today = dateLabel(new Date());
          const monday = new Date(`${today}T12:00:00Z`);
          monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
          return ok([
            { user_id: "00000000-0000-4000-8000-000000000002", display_name: "Amico demo", points: 50, gym_days: 4, position: 1, weekly_streak: 2, multiplier: 1.25 },
            { user_id: userId, display_name: database.name, points: 37.5, gym_days: 3, position: 2, weekly_streak: 3, multiplier: 1.5 },
            { user_id: "00000000-0000-4000-8000-000000000003", display_name: "Amica demo", points: 20, gym_days: 2, position: 3, weekly_streak: 1, multiplier: 1 },
          ].map((row) => ({ ...row, month_start: `${today.slice(0, 7)}-01`, week_start: monday.toISOString().slice(0, 10), starts_on: today })));
        }
        if (name === "save_workout_plan") {
          const errors = validateWorkoutPlan(args.p_definition);
          if (errors.length) throw new Error(errors.join("\n"));
          const existing = database.plans.find((p) => p.id === args.p_version_id);
          if (existing && existing === database.plans.at(-1)
            && JSON.stringify(existing.definition) === JSON.stringify(args.p_definition)) return ok(existing);
          if (existing || args.p_base_version_id !== (database.plans.at(-1)?.id || null)) {
            throw new Error("Il piano è cambiato. Ricarica l'anteprima prima di salvare.");
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
          const plan = database.plans.find((p) => p.id === args.p_plan_version_id);
          const day = plan?.definition.sessions.find((item) => item.id === args.p_session_id);
          if (!plan || !day) throw new Error("Piano di anteprima non disponibile.");
          if (!database.history.some((result) => result.id === args.p_event_id)) {
            database.history.push({
              id: args.p_event_id, completed_at: args.p_completed_at, plan_version_id: plan.id,
              revision: plan.revision, plan_title: plan.definition.title, warmup: plan.definition.warmup,
              session: day, steps: args.p_steps, amrap_rounds: args.p_amrap_rounds,
              measurements: args.p_measurements || {}, amrap_extra_reps: args.p_amrap_extra_reps ?? null,
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
        if (name === "workout_previous") {
          const plan = database.plans.find((p) => p.id === args.p_plan_version_id)?.definition;
          const day = plan?.sessions.find((d) => d.id === args.p_session_id);
          if (!day) throw new Error("Piano di anteprima non disponibile.");
          const e = args.p_exercise_id ? day.exercises.find((e) => e.id === args.p_exercise_id) : null;
          const target = seriesKey(plan, day, e);
          const result = entries().find((e) => e.series_key === target) || null;
          persist();
          return ok(result);
        }
        if (name === "workout_performance") {
          const all = entries();
          const groups = new Map();
          for (const entry of all) {
            if (!groups.has(entry.series_key)) groups.set(entry.series_key, []);
            groups.get(entry.series_key).push(entry);
          }
          const max = (rows, key) => {
            const values = rows.map((r) => r[key]).filter((v) => v != null);
            return values.length ? Math.max(...values) : null;
          };
          const series = [...groups].map(([series_key, rows]) => ({
            series_key, name: rows[0].name, kind: rows[0].kind, context: rows[0].context, workouts: rows.length,
            best_weight: max(rows, "max_weight"), best_reps: max(rows, "max_reps"), best_seconds: max(rows, "max_seconds"),
            best_amrap: [...rows].sort((a, b) => b.rounds - a.rounds || (b.extra_reps || 0) - (a.extra_reps || 0))[0],
          })).sort((a, b) => a.name.localeCompare(b.name) || a.series_key.localeCompare(b.series_key));
          const target = args.p_series || series[0]?.series_key;
          const rows = all.filter((e) => e.series_key === target);
          const cursor = args.p_before_id ? rows.findIndex((row) => row.id === args.p_before_id) + 1 : 0;
          persist();
          return ok({ series, results: rows.slice(cursor, cursor + 20), more: rows.length > cursor + 20 });
        }
        throw new Error(`Unsupported preview RPC: ${name}`);
      },
    };
    return { createClient: () => client };
  };
})();
