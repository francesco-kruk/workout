import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createPreviewServer } from "../scripts/preview.mjs";

test("local preview injects a demo adapter without changing the production entry point", async (t) => {
  const server = createPreviewServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin)).text();
  assert.ok(html.indexOf('/__preview/client.js') < html.indexOf('assets/app.js'));
  assert.equal((await fetch(`${origin}/__preview/client.js`)).status, 200);
  assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  const production = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(production, /preview\/client|preview-client/);

  const dom = new JSDOM(html, { url: origin, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.scrollTo = () => {};
  const requests = [];
  w.fetch = async (path) => {
    requests.push(path);
    assert.ok(String(path).startsWith("./data/workout-plan.json?"), `Unexpected network call: ${path}`);
    return { ok: true, json: async () => JSON.parse(await readFile(new URL("../data/workout-plan.json", import.meta.url), "utf8")) };
  };
  for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const file = match[1] === "/__preview/client.js" ? "scripts/preview-client.js" : match[1];
    w.eval(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  await w.workoutSocial.init();
  assert.ok(w.workoutSocial.snapshot().member);
  assert.equal(w.document.querySelector(".app-nav").hidden, false);
  const app = w.document.querySelector("#workout-app");
  const click = (label) => {
    const button = [...app.querySelectorAll("button")].find((item) => item.textContent === label);
    assert.ok(button, label);
    button.click();
  };
  click("Modifica piano");
  const title = app.querySelector(".plan-editor input");
  title.value = "Piano locale modificato";
  title.dispatchEvent(new w.Event("input", { bubbles: true }));
  app.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  for (let attempt = 0; attempt < 100 && w.workoutLibrary.snapshot().record.revision !== 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(w.workoutLibrary.snapshot().plan.title, "Piano locale modificato");
  assert.equal(JSON.parse(w.localStorage.getItem("workout.preview.database")).plans.at(-1).definition.title, "Piano locale modificato");
  click("Nuovo piano");
  assert.ok(app.querySelector(".plan-editor"));
  assert.equal(w.workoutLibrary.getDraft().definition.title, "La mia scheda");
  w.document.querySelector('[data-view="progress"]').click();
  await w.workoutSocial.refresh();
  assert.equal(app.querySelectorAll(".leaderboard tbody tr").length, 2);
  assert.match(w.document.querySelector(".app-header").textContent, /Anteprima locale/);
  assert.ok(requests.length > 0);
});

test("demo adapter refuses to run on a production origin", async (t) => {
  const dom = new JSDOM("", { url: "https://example.github.io/workout/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const script = await readFile(new URL("../scripts/preview-client.js", import.meta.url), "utf8");
  assert.throws(() => dom.window.eval(script), /only run on localhost/);
});
