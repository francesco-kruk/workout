import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const css = await readFile(new URL("../assets/styles.css", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function theme(t) {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement("style");
  style.textContent = css;
  dom.window.document.head.appendChild(style);
  const rules = [...style.sheet.cssRules];
  const rule = (selector) => {
    const match = rules.findLast((item) => item.selectorText?.split(",").map((part) => part.trim()).includes(selector));
    assert.ok(match, `Missing style for ${selector}`);
    return match.style;
  };
  return { document: dom.window.document, rules, rule, tokens: rule(":root") };
}

function channels(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}

function contrast(a, b) {
  const luminance = (hex) => channels(hex).map((value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("pure-black surfaces contrast with saturated violet Aura, not error colors", (t) => {
  const { tokens } = theme(t);
  for (const name of ["bg", "surface", "surface-raised", "surface-soft"]) {
    const color = tokens.getPropertyValue(`--${name}`).trim();
    const [r, g, b] = channels(color);
    assert.equal(r, g, color);
    assert.equal(g, b, color);
    assert.equal(color, "#000000", "Canvas and every surface stay pure black");
  }
  for (const name of ["accent", "accent-strong"]) {
    const [r, g, b] = channels(tokens.getPropertyValue(`--${name}`).trim());
    assert.ok(b > r && r > g, `${name} is violet`);
  }
  const [neonR, neonG, neonB] = channels(tokens.getPropertyValue("--neon").trim());
  assert.ok(neonB > neonR && neonR > neonG && neonB - neonG >= 200, "Neon remains saturated, not pastel");
  const [r, g, b] = channels(tokens.getPropertyValue("--danger").trim());
  assert.ok(r > g && r > b, "Errors remain visibly red");
  assert.equal(tokens.getPropertyValue("color-scheme"), "dark");
  assert.equal(tokens.getPropertyValue("--radius"), "4px");
  assert.match(tokens.getPropertyValue("--display-font"), /Impact/);
});

test("theme colors meet text and interactive boundary contrast thresholds", (t) => {
  const { tokens } = theme(t);
  const token = (name) => tokens.getPropertyValue(`--${name}`).trim();
  for (const background of ["bg", "surface", "surface-raised", "surface-soft"]) {
    for (const text of ["text", "text-muted", "accent", "accent-strong", "danger"]) {
      assert.ok(contrast(token(text), token(background)) >= 4.5, `${text} on ${background}`);
    }
    assert.ok(contrast(token("control-border"), token(background)) >= 3, `Control boundary on ${background}`);
  }
  assert.ok(contrast(token("accent"), token("accent-ink")) >= 4.5);
  assert.ok(contrast(token("accent-strong"), token("accent-ink")) >= 4.5);
  assert.ok(contrast(token("neon"), token("bg")) >= 3, "Electric card boundaries remain visible on black");
  for (const background of ["bg", "surface", "surface-raised", "surface-soft"]) {
    assert.ok(contrast(token("accent"), token(background)) >= 3, `Focus indicator on ${background}`);
  }
});

test("text and controls remain readable on the strongest layered Aura tints", (t) => {
  const { tokens, rules } = theme(t);
  const token = (name) => tokens.getPropertyValue(`--${name}`).trim();
  const aura = token("aura-rgb").split(/\s+/).map(Number);
  assert.equal(aura.length, 3);
  assert.ok(aura[2] > aura[0] && aura[0] > aura[1], "Ambient light is violet");
  const blend = (base, alpha) => `#${channels(base).map((value, index) =>
    Math.round(value * (1 - alpha) + aura[index] * alpha).toString(16).padStart(2, "0")).join("")}`;
  const tint = Number(token("aura-tint").match(/\/ (\d+)%/)[1]) / 100;
  const backgrounds = rules.map((rule) => rule.style?.getPropertyValue("background") || "").join("\n");
  const alphas = [...backgrounds.matchAll(/rgb\(var\(--aura-rgb\) \/ (\d+)%\)/g)].map((match) => Number(match[1]) / 100);
  const strongest = Math.max(...alphas);
  for (const background of [
    blend(blend(token("bg"), strongest), strongest),
    blend(token("surface"), strongest),
    blend(blend(token("surface-raised"), tint), strongest),
  ]) {
    for (const text of ["text", "text-muted", "accent", "danger"]) {
      assert.ok(contrast(token(text), background) >= 4.5, `${text} on aura tint ${background}`);
    }
    for (const boundary of ["control-border", "accent"]) {
      assert.ok(contrast(token(boundary), background) >= 3, `${boundary} on aura tint ${background}`);
    }
  }
});

test("browser chrome matches the canvas and the stylesheet cache version is updated", (t) => {
  const { document, tokens } = theme(t);
  assert.equal(document.querySelector('meta[name="theme-color"]').content, tokens.getPropertyValue("--bg").trim());
  assert.equal(document.querySelector('link[rel="stylesheet"]').getAttribute("href"), "assets/styles.css?v=16");
  assert.equal(document.documentElement.lang, "it");
});

test("actions and workout statuses preserve distinctive non-color treatments", (t) => {
  const { rule } = theme(t);
  assert.equal(rule("body").getPropertyValue("background"), "var(--bg)");
  for (const selector of [".app-nav", ".workout-actions"]) {
    assert.equal(rule(selector).getPropertyValue("background"), "var(--bg)");
  }
  assert.equal(rule(".btn-primary").getPropertyValue("background"), "var(--bg)");
  assert.equal(rule(".btn-primary").getPropertyValue("color"), "var(--accent-strong)");
  assert.equal(rule(".btn-primary").getPropertyValue("border"), "1px solid var(--accent)");
  assert.equal(rule(".app-nav button.active").getPropertyValue("background"), "var(--bg)");
  assert.equal(rule(".app-nav button.active").getPropertyValue("color"), "var(--accent-strong)");
  assert.equal(rule(".status-badge.completed").getPropertyValue("background"), "var(--accent)");
  assert.equal(rule(".status-badge.skipped").getPropertyValue("border-style"), "dashed");
  assert.equal(rule(".status-badge.optional").getPropertyValue("border-style"), "dashed");
  assert.equal(rule(".social-status.error").getPropertyValue("color"), "var(--danger)");
  assert.equal(rule(".btn:disabled").getPropertyValue("cursor"), "not-allowed");
  assert.equal(rule(".btn").getPropertyValue("min-height"), "52px");
});

test("five-view navigation and separated panels retain responsive Aura styling", (t) => {
  const { document, rule } = theme(t);
  assert.equal(document.querySelectorAll(".app-nav button").length, 5);
  assert.equal(rule(".app-nav").getPropertyValue("grid-template-columns"), "repeat(5, minmax(0, 1fr))");
  assert.equal(rule(".app-nav button").getPropertyValue("min-height"), "55px");
  assert.equal(rule(".app-nav button").getPropertyValue("min-width"), "0");
  assert.equal(rule(".app-nav button").getPropertyValue("white-space"), "nowrap");
  assert.equal(rule(".app-nav .nav-label").getPropertyValue("overflow-wrap"), "anywhere");
  assert.equal(rule(".app-nav .nav-label").getPropertyValue("font-size"), "inherit");
  assert.equal(rule(".ranking-metrics .aura-metric").getPropertyValue("grid-column"), "1 / -1");
  assert.equal(rule(".personal-performance").getPropertyValue("border-top"), "2px solid var(--neon)");
  assert.equal(rule(".ranking-overview").getPropertyValue("border-top"), "2px solid var(--neon)");
  assert.equal(rule(".leaderboard-scroll").getPropertyValue("overflow-x"), "auto");
});

test("all form controls have visible keyboard focus and motion preferences are respected", (t) => {
  const { rule, rules } = theme(t);
  for (const selector of [
    "button:focus-visible", "summary:focus-visible", "input:focus-visible",
    "select:focus-visible", "textarea:focus-visible", ".set-check:has(input:focus-visible)",
  ]) {
    assert.equal(rule(selector).getPropertyValue("outline"), "2px solid var(--accent)");
    assert.equal(rule(selector).getPropertyValue("outline-offset"), "3px");
  }
  const reducedMotion = rules.find((item) => item.conditionText === "(prefers-reduced-motion: reduce)");
  assert.ok(reducedMotion);
  const reducedStyle = reducedMotion.cssRules[0];
  assert.deepEqual(reducedStyle.selectorText.split(",").map((selector) => selector.trim()), ["*", "*::before", "*::after"]);
  for (const property of ["animation", "transition"]) {
    assert.equal(reducedStyle.style.getPropertyValue(property), "none");
    assert.equal(reducedStyle.style.getPropertyPriority(property), "important");
  }
});

test("electric Aura motion uses non-interactive layers and keeps text stationary", (t) => {
  const { rule } = theme(t);
  assert.equal(rule(".progress-metrics .aura-metric").getPropertyValue("overflow"), "hidden");
  assert.equal(rule(".aura-metric dd").getPropertyValue("color"), "var(--accent)");
  assert.equal(rule(".leaderboard .aura-score").getPropertyValue("color"), "var(--accent)");
  assert.equal(rule(".progress-metrics dd").getPropertyValue("color"), "var(--text)");
  assert.equal(rule(".progress-bar").getPropertyValue("overflow"), "hidden");
  assert.equal(rule(".progress-fill").getPropertyValue("overflow"), "hidden");
  assert.equal(rule(".focus-card").getPropertyValue("background"), "var(--surface)");
  assert.equal(rule(".focus-card").getPropertyValue("border-color"), "var(--neon)");
  for (const selector of [".aura-metric::before", ".progress-fill::after"]) {
    assert.equal(rule(selector).getPropertyValue("pointer-events"), "none");
    assert.match(rule(selector).getPropertyValue("animation"), /infinite/);
  }
  assert.equal(rule(".progress-fill::after").getPropertyValue("animation"), "progress-energy 2.4s linear infinite");
  assert.equal(rule("body::before").getPropertyValue("pointer-events"), "none");
  assert.equal(rule("body::before").getPropertyValue("position"), "fixed");
  assert.equal(rule("body::before").getPropertyValue("animation"), "aura-streams 18s linear infinite");
  for (const selector of [
    ".auth-panel::after", ".focus-card::after", ".completion-card::after",
    ".aura-metric::after", ".plan-content > .overview-card::after",
  ]) {
    assert.equal(rule(selector).getPropertyValue("mask-composite"), "exclude");
    assert.equal(rule(selector).getPropertyValue("pointer-events"), "none");
    assert.equal(rule(selector).getPropertyValue("animation"), "electric-current 4s linear infinite");
  }
  for (const selector of [".btn-primary", ".app-nav button.active"]) {
    assert.equal(rule(selector).getPropertyValue("animation"), "electric-current 5s linear infinite");
    assert.match(rule(selector).getPropertyValue("background-image"), /var\(--aura-tint\)/);
  }
  for (const selector of [".aura-metric dd", ".focus-card h3"]) {
    assert.equal(rule(selector).getPropertyValue("animation"), "");
  }
});
