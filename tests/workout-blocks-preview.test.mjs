import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = (await readFile(new URL("../index.html", import.meta.url), "utf8"))
  .replace('<script src="assets/app.js"></script>',
    '<script src="scripts/preview-client.js"></script><script src="assets/app.js"></script>');
const mixed = JSON.parse(await readFile(new URL("../data/workout-blocks-example.json", import.meta.url)));
const original = JSON.parse(await readFile(new URL("../data/workout-plan.json", import.meta.url)));
const sources = await Promise.all([...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) =>
  readFile(new URL(`../${match[1]}`, import.meta.url), "utf8")));

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Preview did not reach the expected state");
}

test("mixed workout saves, executes, syncs once and exposes private block history and trends", async (t) => {
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
  w.structuredClone = structuredClone;
  w.scrollTo = () => {};
  const errors = [];
  w.console.error = (...args) => errors.push(args);
  w.fetch = async () => ({ ok: true, json: async () => structuredClone(original) });
  sources.forEach((script) => w.eval(script));
  await until(() => w.workoutLibrary.snapshot().record);
  const before = w.workoutLibrary.snapshot().record;
  const candidate = structuredClone(mixed);
  candidate.trackingId = "mixed-demo";
  candidate.sessions[0].blocks[0].exercises[0].rest = 0;
  candidate.sessions[0].blocks[1].restSeconds = 0;
  await w.workoutLibrary.save(w.workoutLibrary.writeDraft(candidate, before.id));
  w.document.querySelector('[data-view="workout"]').click();
  const app = w.document.querySelector("#workout-app");
  const click = (caption) => {
    const button = [...app.querySelectorAll("button")].find((b) => b.textContent === caption);
    assert.ok(button, caption);
    assert.equal(button.disabled, false, `${caption} disabled`);
    button.click();
  };
  while (app.querySelector("[data-complete-set]")) {
    if ([...app.querySelectorAll("button")].some((b) => b.textContent === "Salta giro opzionale")) {
      click("Salta giro opzionale");
      break;
    }
    for (const input of app.querySelectorAll("[data-actual-field]")) {
      input.value = input.dataset.actualField === "weightKg" ? "12" : "8";
      input.dispatchEvent(new w.Event("input"));
    }
    click("Serie completata");
  }
  assert.match(app.textContent, /Circuito AMRAP/);
  let now = Date.now();
  w.Date.now = () => now;
  click("Avvia timer");
  click("+");
  click("+");
  now += 600000;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  click("Completa AMRAP");
  assert.match(app.textContent, /EMOM alternato/);
  click("Avvia timer");
  click("Minuto completato");
  now += 360000;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  const select = app.querySelector('[aria-label="Rivedi minuto EMOM"]');
  assert.equal(select.options.length, 6);
  assert.equal(w.getProgress("mixed-day").blocks["emom-block"].minutes[1], undefined);
  for (let index = 1; index < 6; index++) {
    const currentSelect = app.querySelector('[aria-label="Rivedi minuto EMOM"]');
    currentSelect.value = String(index);
    currentSelect.dispatchEvent(new w.Event("change"));
    click("Minuto mancato");
  }
  click("Completa EMOM");
  assert.match(app.textContent, /Giornata completata/);
  await until(() => w.workoutLibrary.snapshot().history.some((row) => row.session_id === "mixed-day" || row.session.id === "mixed-day"));
  const history = w.workoutLibrary.snapshot().history.find((row) => row.session.id === "mixed-day");
  assert.equal(history.block_results["amrap-block"].rounds, 2);
  assert.equal(history.block_results["emom-block"].minutes[0].status, "completed");
  assert.equal(history.block_results["emom-block"].minutes[1].status, "missed");
  assert.equal(history.measurements["superset-row:0"].weightKg, 12);
  assert.equal(history.steps["superset-row:3"], "skipped");
  assert.equal(w.pendingAttendance(w.workoutSocial.snapshot().user.id).length, 0);
  const all = await w.workoutSocial.fetchPerformance();
  const emomSeries = all.series.find((series) => series.kind === "emom");
  assert.ok(emomSeries);
  const performance = await w.workoutSocial.fetchPerformance(emomSeries.series_key);
  assert.equal(performance.results[0].rounds, 1);
  assert.equal(performance.results[0].extra_reps, 5);
  assert.equal((await w.workoutSocial.fetchPrevious("mixed-day", null, "amrap-block")).rounds, 2);
  w.document.querySelector('[data-view="progress"]').click();
  await until(() => app.querySelector(".workout-history li"));
  assert.match(app.querySelector(".workout-history").textContent, /Minuto 2: Mancato/);
  assert.equal(errors.length, 0, errors.map((args) => args.join(" ")).join("\n"));
});
