#!/usr/bin/env node
// Zero-dependency validator for data/workout-plan.json, run by CI on PRs
// that touch the plan file. Exits non-zero on any validation failure.
import { readFileSync } from "node:fs";

const PLAN_PATH = "data/workout-plan.json";

function fail(message) {
  console.error(`Validation failed: ${message}`);
  process.exitCode = 1;
}

let raw;
try {
  raw = readFileSync(PLAN_PATH, "utf8");
} catch (err) {
  fail(`could not read ${PLAN_PATH}: ${err.message}`);
  process.exit(1);
}

let plan;
try {
  plan = JSON.parse(raw);
} catch (err) {
  fail(`${PLAN_PATH} is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(plan.days) || plan.days.length === 0) {
  fail("plan.days must be a non-empty array");
}

const seenIds = new Set();

for (const day of plan.days || []) {
  if (typeof day.id !== "string" || !day.id) {
    fail("every day must have a non-empty string id");
    continue;
  }
  if (seenIds.has(day.id)) fail(`duplicate id: ${day.id}`);
  seenIds.add(day.id);

  if (typeof day.label !== "string" || !day.label.trim()) {
    fail(`day ${day.id} is missing a label`);
  }
  if (typeof day.type !== "string" || !day.type.trim()) {
    fail(`day ${day.id} is missing a type`);
  }
  if (!Array.isArray(day.exercises)) {
    fail(`day ${day.id} exercises must be an array`);
    continue;
  }

  for (const ex of day.exercises) {
    if (typeof ex.id !== "string" || !ex.id) {
      fail(`an exercise in day ${day.id} is missing a string id`);
      continue;
    }
    if (seenIds.has(ex.id)) fail(`duplicate id: ${ex.id}`);
    seenIds.add(ex.id);

    if (typeof ex.name !== "string" || !ex.name.trim()) {
      fail(`exercise ${ex.id} is missing a name`);
    }
    if (!Number.isInteger(ex.sets) || ex.sets < 1) {
      fail(`exercise ${ex.id} must have an integer sets >= 1`);
    }
    if (typeof ex.target !== "string") {
      fail(`exercise ${ex.id} must have a string target`);
    }
    if (typeof ex.defaultValue !== "string") {
      fail(`exercise ${ex.id} must have a string defaultValue (use "" if none)`);
    }
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("workout-plan.json is valid.");
