window.workoutAudio = (() => {
  const key = "workout.restSoundMuted";
  let context = null;
  let preparing = null;
  let error = "";

  function report(failure) {
    console.error("Suono dei timer non disponibile.", failure);
    error = `Suono dei timer non disponibile. ${failure.message}`;
    window.dispatchEvent(new Event("workout-audio-change"));
  }

  function muted() {
    return localStorage.getItem(key) === "true";
  }

  function setMuted(value) {
    localStorage.setItem(key, String(value));
    error = "";
    window.dispatchEvent(new Event("workout-audio-change"));
  }

  async function prepare() {
    try {
      if (muted() || context?.state === "running") return;
      if (preparing) return await preparing;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("Questo browser non supporta l'audio.");
      context ||= new AudioContext();
      preparing = context.resume();
      await preparing;
      if (context.state !== "running") throw new Error("Tocca un controllo dell'allenamento per abilitare l'audio.");
      error = "";
      window.dispatchEvent(new Event("workout-audio-change"));
    } catch (failure) {
      report(failure);
    } finally {
      preparing = null;
    }
  }

  function play() {
    let oscillator;
    let gain;
    try {
      if (muted()) return;
      if (context?.state !== "running") throw new Error("Tocca un controllo dell'allenamento per abilitare l'audio.");
      oscillator = context.createOscillator();
      gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.frequency.value = 880;
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + 0.35);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(now);
      oscillator.stop(now + 0.36);
    } catch (failure) {
      oscillator?.disconnect();
      gain?.disconnect();
      report(failure);
    }
  }

  return { muted, setMuted, prepare, play, error: () => error };
})();
