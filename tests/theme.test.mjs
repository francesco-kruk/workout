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
    const match = rules.find((item) => item.selectorText?.split(",").map((part) => part.trim()).includes(selector));
    assert.ok(match, `Missing style for ${selector}`);
    return match.style;
  };
  return { document: dom.window.document, rule, tokens: rule(":root") };
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

test("the palette and hard-coded colors are grayscale except the error token", (t) => {
  const { tokens } = theme(t);
  const danger = tokens.getPropertyValue("--danger").trim();
  for (const [color] of css.matchAll(/#[0-9a-f]{6}\b/gi)) {
    if (color === danger) continue;
    const [r, g, b] = channels(color);
    assert.equal(r, g, color);
    assert.equal(g, b, color);
  }
  for (const [, r, g, b] of css.matchAll(/rgb\((\d+) (\d+) (\d+)/g)) {
    assert.equal(r, g);
    assert.equal(g, b);
  }
  const [r, g, b] = channels(danger);
  assert.ok(r > g && r > b, "Errors remain visibly red");
  assert.equal(tokens.getPropertyValue("color-scheme"), "dark");
});

test("theme colors meet text and interactive boundary contrast thresholds", (t) => {
  const { tokens } = theme(t);
  const token = (name) => tokens.getPropertyValue(`--${name}`).trim();
  for (const background of ["bg", "surface", "surface-raised", "surface-soft"]) {
    for (const text of ["text", "text-muted", "danger"]) {
      assert.ok(contrast(token(text), token(background)) >= 4.5, `${text} on ${background}`);
    }
    assert.ok(contrast(token("control-border"), token(background)) >= 3, `Control boundary on ${background}`);
  }
  assert.ok(contrast(token("accent"), token("accent-ink")) >= 4.5);
});

test("browser chrome matches the canvas and the stylesheet cache version is updated", (t) => {
  const { document, tokens } = theme(t);
  assert.equal(document.querySelector('meta[name="theme-color"]').content, tokens.getPropertyValue("--bg").trim());
  assert.equal(document.querySelector('link[rel="stylesheet"]').getAttribute("href"), "assets/styles.css?v=11");
  assert.equal(document.documentElement.lang, "it");
});

test("actions and workout statuses preserve distinctive non-color treatments", (t) => {
  const { rule } = theme(t);
  assert.equal(rule(".btn-primary").getPropertyValue("background"), "var(--accent)");
  assert.equal(rule(".btn-primary").getPropertyValue("color"), "var(--accent-ink)");
  assert.equal(rule(".app-nav button.active").getPropertyValue("background"), "var(--accent)");
  assert.equal(rule(".app-nav button.active").getPropertyValue("color"), "var(--accent-ink)");
  assert.equal(rule(".status-badge.completed").getPropertyValue("background"), "var(--accent)");
  assert.equal(rule(".status-badge.skipped").getPropertyValue("border-style"), "dashed");
  assert.equal(rule(".status-badge.optional").getPropertyValue("border-style"), "dashed");
  assert.equal(rule(".social-status.error").getPropertyValue("color"), "var(--danger)");
  assert.equal(rule(".btn:disabled").getPropertyValue("cursor"), "not-allowed");
  assert.equal(rule(".btn").getPropertyValue("min-height"), "52px");
});

test("all form controls have visible keyboard focus and motion preferences are respected", (t) => {
  const { rule } = theme(t);
  for (const selector of [
    "button:focus-visible", "summary:focus-visible", "input:focus-visible",
    "select:focus-visible", "textarea:focus-visible", ".set-check:has(input:focus-visible)",
  ]) {
    assert.equal(rule(selector).getPropertyValue("outline"), "2px solid var(--accent)");
    assert.equal(rule(selector).getPropertyValue("outline-offset"), "3px");
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /transition: none !important/);
});
