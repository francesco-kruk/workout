async function loadSupabaseClient() {
  return import("https://esm.sh/@supabase/supabase-js@2.57.4?bundle");
}

window.workoutSocial = (() => {
  const state = {
    configured: false,
    ready: false,
    accessReady: false,
    busy: false,
    user: null,
    member: null,
    rows: [],
    updatedAt: null,
    error: "",
    notice: "",
  };
  let client = null;
  let syncing = false;
  let identityRevision = 0;
  let membershipRequest = 0;
  let leaderboardRequest = 0;
  let initPromise = null;
  let refreshAgain = false;
  let updatingCredentials = false;

  function notify() {
    window.dispatchEvent(new Event("workout-social-change"));
  }

  function finishBusy() {
    state.busy = false;
    notify();
    if (refreshAgain) {
      refreshAgain = false;
      window.setTimeout(() => { void refresh(); }, 0);
    }
  }

  function fail(error, message) {
    console.error(message, error);
    state.error = `${message} ${error.message || String(error)}`;
    notify();
  }

  function snapshot() {
    return { ...state, rows: [...state.rows] };
  }

  function check(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function setIdentity(session) {
    const nextUser = session?.user || null;
    if (state.user?.id !== nextUser?.id) {
      identityRevision += 1;
      state.member = null;
      state.rows = [];
      state.updatedAt = null;
      state.accessReady = false;
      state.error = "";
      state.user = nextUser;
      window.workoutLibrary?.identityChanged(nextUser?.id || null);
    }
    state.user = nextUser;
    notify();
  }

  async function loadMembership() {
    if (!client || !state.user) return;
    const userId = state.user.id;
    const revision = identityRevision;
    const request = ++membershipRequest;
    const member = check(await client.from("friend_members")
      .select("user_id,display_name").eq("user_id", userId).maybeSingle());
    if (revision !== identityRevision || request !== membershipRequest) return;
    state.member = member;
    if (!member) {
      state.rows = [];
    }
    notify();
  }

  async function loadLeaderboard() {
    if (!client || !state.member) return;
    const revision = identityRevision;
    const request = ++leaderboardRequest;
    const rows = check(await client.rpc("friends_leaderboard"));
    if (revision !== identityRevision || request !== leaderboardRequest) return;
    state.rows = rows;
    state.updatedAt = new Date().toISOString();
    notify();
  }

  async function sync() {
    if (syncing || !client || !state.member || !navigator.onLine) return;
    syncing = true;
    const userId = state.user.id;
    try {
      const attempted = new Set();
      let invalidEvent = null;
      let submittedWorkout = false;
      while (state.user?.id === userId && state.member) {
        const pending = pendingAttendance(userId).filter((receipt) => !attempted.has(receipt.id));
        if (pending.length === 0) break;
        for (const receipt of pending) {
          if (state.user?.id !== userId || !state.member) break;
          attempted.add(receipt.id);
          const session = check(await client.auth.getSession())?.session;
          if (session?.user.id !== userId) {
            throw new Error("Accedi nuovamente con l'account che ha completato l'allenamento.");
          }
          const args = {
            p_user_id: userId,
            p_event_id: receipt.id,
            p_completed_at: receipt.completedAt,
          };
          if (receipt.workout) {
            Object.assign(args, {
              p_plan_version_id: receipt.workout.planVersionId,
              p_session_id: receipt.workout.sessionId,
              p_steps: receipt.workout.steps,
              p_amrap_rounds: receipt.workout.amrapRounds,
              p_measurements: receipt.workout.measurements || {},
              p_amrap_extra_reps: receipt.workout.amrapExtraReps ?? null,
            });
            if (receipt.workout.payloadVersion === 3) {
              delete args.p_amrap_rounds;
              delete args.p_amrap_extra_reps;
              args.p_block_results = receipt.workout.blockResults;
            }
          }
          const result = await client.rpc(receipt.workout?.payloadVersion === 3
            ? "submit_workout_result_v3" : receipt.workout ? "submit_workout_result" : "submit_gym_day", args);
          if (result.error?.code === "22023") {
            invalidEvent = new Error(`Presenza ${receipt.id}: ${result.error.message}`);
            console.error("Presenza rifiutata; conservata per verifica.", invalidEvent);
            continue;
          }
          check(result);
          acknowledgeAttendance(receipt.id, userId);
          if (receipt.workout) submittedWorkout = true;
        }
      }
      await loadLeaderboard();
      if (submittedWorkout) await window.workoutLibrary?.loadHistory();
      if (invalidEvent) throw invalidEvent;
      state.error = "";
    } catch (error) {
      fail(error, "Sincronizzazione non riuscita. Le presenze restano in attesa.");
    } finally {
      syncing = false;
      notify();
    }
  }

  async function refresh() {
    if (!client) return;
    if (state.busy) {
      refreshAgain = true;
      return;
    }
    state.busy = true;
    state.error = "";
    state.notice = "";
    notify();
    try {
      const revision = identityRevision;
      const data = check(await client.auth.getSession());
      if (revision !== identityRevision && state.user?.id !== data.session?.user.id) return;
      setIdentity(data.session);
      const userRevision = identityRevision;
      await loadMembership();
      if (userRevision !== identityRevision) return;
      await window.workoutLibrary?.load();
      if (userRevision !== identityRevision) return;
      state.accessReady = true;
      state.ready = true;
      notify();
      if (state.member) {
        if (navigator.onLine) await sync();
        else state.notice = "Sei offline. Le presenze verranno inviate alla riconnessione.";
      }
    } catch (error) {
      fail(error, "Verifica dell'accesso non riuscita.");
    } finally {
      finishBusy();
    }
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const config = window.WORKOUT_SOCIAL_CONFIG || {};
      state.configured = Boolean(config.url && config.publishableKey);
      if (!state.configured) {
        state.ready = true;
        notify();
        return;
      }
      try {
        const callbackParams = new URLSearchParams(location.hash.slice(1));
        const queryError = new URLSearchParams(location.search);
        const callbackFailure = callbackParams.get("error") || queryError.get("error");
        const description = callbackParams.get("error_description") || queryError.get("error_description");
        let callbackError = null;
        if (callbackFailure || description) {
          history.replaceState(null, "", location.pathname);
          callbackError = new Error(`Link di accesso non valido o scaduto: ${description || callbackFailure}`);
        }
        const { createClient } = await loadSupabaseClient();
        client = createClient(config.url, config.publishableKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        client.auth.onAuthStateChange((_event, session) => {
          setIdentity(session);
          // Supabase auth callbacks must not await other auth operations.
          window.setTimeout(() => { void refresh(); }, 0);
        });
        await refresh();
        if (callbackError) fail(callbackError, "Accesso non riuscito.");
      } catch (error) {
        fail(error, "Accesso social non disponibile.");
      } finally {
        state.ready = true;
        notify();
      }
    })();
    return initPromise;
  }

  async function authenticate(email, password, creatingAccount) {
    if (state.busy) return;
    state.error = "";
    state.notice = "";
    state.busy = true;
    notify();
    let session = null;
    try {
      if (!client) throw new Error("Connessione social non disponibile. Ricarica la pagina.");
      if (!email || !password) throw new Error("Inserisci email e password.");
      if (creatingAccount && password.length < 8) {
        throw new Error("Scegli una password di almeno 8 caratteri.");
      }
      const data = check(await (creatingAccount
        ? client.auth.signUp({ email, password })
        : client.auth.signInWithPassword({ email, password })));
      if (!data.session) {
        throw new Error(creatingAccount
          ? "Nessuna sessione ricevuta. Contatta il proprietario: deve verificare l'account e disattivare la conferma email in Supabase."
          : "Nessuna sessione ricevuta. Riprova ad accedere.");
      }
      session = data.session;
      setIdentity(session);
    } catch (error) {
      fail(error, creatingAccount ? "Registrazione non riuscita." : "Accesso non riuscito.");
    } finally {
      finishBusy();
    }
    if (session) await refresh();
  }

  function signIn(email, password) {
    return authenticate(email, password, false);
  }

  function signUp(email, password) {
    return authenticate(email, password, true);
  }

  async function signOut() {
    if (updatingCredentials) return;
    const previousUser = state.user;
    state.busy = true;
    setIdentity(null);
    state.notice = "";
    notify();
    try {
      check(await client.auth.signOut({ scope: "local" }));
      setIdentity(null);
      state.error = "";
    } catch (error) {
      if (!state.user && previousUser) setIdentity({ user: previousUser });
      fail(error, "Uscita non riuscita. Riprova prima di cambiare account.");
    } finally {
      finishBusy();
    }
  }

  async function saveName(name) {
    if (state.busy) return { ok: false, error: "Attendi la fine dell'operazione in corso." };
    const revision = identityRevision;
    state.busy = true;
    state.error = "";
    notify();
    try {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 40) throw new Error("Usa un nome da 1 a 40 caratteri.");
      if (!state.member) throw new Error("È richiesta l'approvazione al gruppo.");
      const member = check(await client.from("friend_members")
        .update({ display_name: trimmed }).eq("user_id", state.user.id)
        .select("user_id,display_name").single());
      if (revision !== identityRevision) return { ok: false, error: "L'account è cambiato. Riapri Profilo." };
      state.member = member;
      await loadLeaderboard();
      if (revision !== identityRevision) return { ok: false, error: "L'account è cambiato. Riapri Profilo." };
      return { ok: true, message: "Nome aggiornato." };
    } catch (error) {
      if (revision === identityRevision) fail(error, "Nome non salvato.");
      return { ok: false, error: `Nome non salvato. ${error.message || String(error)}` };
    } finally {
      finishBusy();
    }
  }

  async function updateCredentials(kind, value, currentPassword) {
    if (state.busy) return { ok: false, error: "Attendi la fine dell'operazione in corso." };
    const revision = identityRevision;
    const userId = state.user?.id;
    const email = state.user?.email;
    const assertOwner = () => {
      if (revision !== identityRevision || state.user?.id !== userId) {
        throw new Error("L'account è cambiato. Riapri Profilo prima di riprovare.");
      }
    };
    state.busy = true;
    updatingCredentials = true;
    notify();
    try {
      if (!client || !userId || !email || !state.member) throw new Error("Accedi nuovamente al tuo account approvato.");
      if (!currentPassword) throw new Error("Inserisci la password attuale.");
      if (kind === "password" && value.length < 8) throw new Error("Scegli una password di almeno 8 caratteri.");
      if (kind === "email" && (!value || !/^[^\s@]+@[^\s@]+$/.test(value))) throw new Error("Inserisci un indirizzo email valido.");
      if (kind === "email" && value.toLowerCase() === email.toLowerCase()) throw new Error("Inserisci un'email diversa da quella attuale.");
      const initial = check(await client.auth.getSession())?.session;
      assertOwner();
      if (initial?.user.id !== userId) throw new Error("Sessione scaduta o cambiata. Accedi nuovamente.");
      const verified = check(await client.auth.signInWithPassword({ email, password: currentPassword }));
      currentPassword = "";
      assertOwner();
      if (verified.session?.user.id !== userId) throw new Error("Impossibile verificare l'account corrente.");
      const session = check(await client.auth.getSession())?.session;
      assertOwner();
      if (session?.user.id !== userId) throw new Error("Sessione scaduta o cambiata. Accedi nuovamente.");
      const data = check(await client.auth.updateUser({ [kind]: value }));
      assertOwner();
      if (data.user?.id !== userId) throw new Error("Risposta dell'account non valida. Aggiorna Profilo.");
      setIdentity({ user: data.user });
      if (kind === "email") {
        const effective = data.user.email;
        return {
          ok: true,
          message: effective?.toLowerCase() === value.toLowerCase()
            ? "Email aggiornata."
            : "Modifica email richiesta. Controlla la posta al vecchio e al nuovo indirizzo e completa le conferme richieste. L'email attuale resta valida fino alla conferma.",
        };
      }
      return { ok: true, message: "Password aggiornata." };
    } catch (error) {
      const message = `Modifica ${kind === "email" ? "email" : "password"} non riuscita. ${error.message || String(error)}`;
      console.error("Aggiornamento credenziali non riuscito.", error.message || String(error));
      return { ok: false, error: message };
    } finally {
      currentPassword = "";
      value = "";
      updatingCredentials = false;
      finishBusy();
    }
  }

  function updateEmail(email, currentPassword) {
    return updateCredentials("email", email.trim(), currentPassword);
  }

  function updatePassword(password, currentPassword) {
    return updateCredentials("password", password, currentPassword);
  }

  function recordCompletion(runId, workout = null) {
    try {
      if (!runId) throw new Error("Identificativo allenamento mancante.");
      recordAttendance(runId, state.member?.user_id || null, new Date().toISOString(), workout);
      notify();
      void sync();
    } catch (error) {
      fail(error, "Presenza non salvata sul dispositivo.");
    }
  }

  function completionMessage(runId) {
    try {
      const receipt = readAttendance().receipts[runId];
      if (!receipt) return "Le presenze precedenti non vengono aggiunte alla classifica.";
      if (receipt.status === "uncredited") {
        return "Non conteggiato in classifica: accedi al gruppo prima di completare un allenamento.";
      }
      if (receipt.userId !== state.user?.id) {
        return "Presenza associata all'account usato durante l'allenamento.";
      }
      return receipt.status === "synced"
        ? "Presenza sincronizzata. Ogni data vale una sola volta."
        : "Presenza salvata sul dispositivo, in attesa di sincronizzazione.";
    } catch (error) {
      return `Impossibile leggere la presenza: ${error.message}`;
    }
  }

  window.addEventListener("online", () => {
    state.notice = "";
    void refresh();
  });
  window.addEventListener("offline", () => {
    state.notice = "Sei offline. Le presenze verranno inviate alla riconnessione.";
    notify();
  });
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith(ATTENDANCE_KEY)) {
      notify();
      void sync();
    }
  });

  function requireMember(userId = state.user?.id) {
    if (!client || !state.member || userId !== state.user?.id) throw new Error("È richiesto l'accesso al gruppo.");
  }

  async function fetchPersonalPlan(userId, versionId = null) {
    requireMember(userId);
    let query = client.from("workout_plan_versions").select("*").eq("user_id", userId);
    if (versionId !== null) query = query.eq("id", versionId);
    return check(await query.order("revision", { ascending: false }).limit(1).maybeSingle());
  }

  async function savePersonalPlan(userId, draft) {
    requireMember(userId);
    return check(await client.rpc("save_workout_plan", {
      p_user_id: userId, p_version_id: draft.versionId,
      p_base_version_id: draft.baseVersionId, p_definition: draft.definition,
    }));
  }

  async function fetchWorkoutHistory(cursor) {
    requireMember();
    const rows = check(await client.rpc("workout_history", {
      p_before_completed_at: cursor?.completed_at || null, p_before_id: cursor?.id || null,
    }));
    if (!Array.isArray(rows)) throw new Error("Risposta dello storico non valida.");
    return rows;
  }

  async function fetchPerformance(series = null, cursor = null) {
    requireMember();
    const revision = identityRevision;
    const data = check(await client.rpc("workout_performance", {
      p_series: series, p_before_completed_at: cursor?.completed_at || null, p_before_id: cursor?.id || null,
    }));
    if (revision !== identityRevision) throw new Error("Account cambiato. Riapri Progressi.");
    if (!data || !Array.isArray(data.series) || !Array.isArray(data.results) || typeof data.more !== "boolean") {
      throw new Error("Risposta delle statistiche non valida.");
    }
    return data;
  }

  async function fetchPrevious(sessionId, exerciseId = null, blockId = null) {
    requireMember();
    const revision = identityRevision;
    const record = window.workoutLibrary.snapshot().record;
    if (!record) return null;
    const data = check(await client.rpc(record.definition.version === 3 ? "workout_previous_v3" : "workout_previous", {
      p_plan_version_id: record.id, p_session_id: sessionId, p_exercise_id: exerciseId,
      ...(record.definition.version === 3 ? { p_block_id: blockId } : {}),
    }));
    if (revision !== identityRevision) throw new Error("Account cambiato.");
    return data;
  }

  async function manualRpc(name, args) {
    requireMember();
    if (!navigator.onLine) throw new Error("Torna online per inviare o votare un allenamento manuale.");
    const revision = identityRevision;
    const data = check(await client.rpc(name, args));
    if (revision !== identityRevision) throw new Error("Account cambiato durante la richiesta. Riprova con l'account originale.");
    return data;
  }

  async function submitManualWorkout(intent) {
    const row = await manualRpc("submit_manual_workout", {
      p_id: intent.id, p_plan_version_id: intent.planVersionId, p_session_id: intent.sessionId,
      p_description: intent.description, p_replaces_planned: intent.replacesPlanned,
    });
    if (!row || row.id !== intent.id || !Number.isFinite(Date.parse(row.completed_at))) {
      throw new Error("Risposta dell'invio manuale non valida. Riprova senza cambiare richiesta.");
    }
    return row;
  }

  async function fetchManualWorkouts(own, cursor = null) {
    const rows = await manualRpc("manual_workout_activity", {
      p_own: own, p_before_completed_at: cursor?.completed_at || null, p_before_id: cursor?.id || null,
    });
    if (!Array.isArray(rows)) throw new Error("Risposta delle revisioni non valida.");
    return rows;
  }

  async function voteManualWorkout(id, approve) {
    const row = await manualRpc("vote_manual_workout", { p_id: id, p_approve: approve });
    if (!row || row.id !== id) throw new Error("Risposta del voto non valida. Riprova lo stesso voto.");
    try { await loadLeaderboard(); }
    catch (error) { fail(error, "Voto salvato, classifica non aggiornata. Riprova l'aggiornamento."); }
    return row;
  }

  return { init, snapshot, refresh, signIn, signUp, signOut, saveName, updateEmail, updatePassword, recordCompletion, completionMessage, reportError: fail,
    fetchPersonalPlan, savePersonalPlan, fetchWorkoutHistory, fetchPerformance, fetchPrevious,
    submitManualWorkout, fetchManualWorkouts, voteManualWorkout };
})();
