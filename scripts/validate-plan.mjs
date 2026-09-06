#!/usr/bin/env node
import { readFileSync } from "node:fs";

const PLAN_PATH = "data/workout-plan.json";

function fail(message) {
  console.error(`Validazione non riuscita: ${message}`);
  process.exitCode = 1;
}

function requireString(value, path, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    fail(`${path} deve essere una stringa${allowEmpty ? "" : " non vuota"}`);
  }
}

let plan;
try {
  plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
} catch (error) {
  fail(`impossibile leggere ${PLAN_PATH}: ${error.message}`);
  process.exit(1);
}

if (plan.version !== 2) fail("version deve essere 2");
requireString(plan.title, "title");

if (!Array.isArray(plan.warmup) || plan.warmup.length === 0) {
  fail("warmup deve essere un array non vuoto");
}
if (!Array.isArray(plan.sessions) || plan.sessions.length === 0) {
  fail("sessions deve essere un array non vuoto");
}

const ids = new Set();
function validateId(id, path) {
  requireString(id, `${path}.id`);
  if (ids.has(id)) fail(`id duplicato: ${id}`);
  ids.add(id);
}

for (const [index, item] of (plan.warmup || []).entries()) {
  const path = `warmup[${index}]`;
  validateId(item.id, path);
  requireString(item.name, `${path}.name`);
  requireString(item.target, `${path}.target`);
  requireString(item.instructions, `${path}.instructions`, true);
}

for (const [sessionIndex, session] of (plan.sessions || []).entries()) {
  const path = `sessions[${sessionIndex}]`;
  validateId(session.id, path);
  requireString(session.label, `${path}.label`);

  if (!["standard", "amrap"].includes(session.type)) {
    fail(`${path}.type deve essere standard oppure amrap`);
  }
  if (!Array.isArray(session.exercises) || session.exercises.length === 0) {
    fail(`${path}.exercises deve essere un array non vuoto`);
    continue;
  }

  if (session.type === "amrap") {
    requireString(session.duration, `${path}.duration`);
    requireString(session.instructions, `${path}.instructions`);
  }

  for (const [exerciseIndex, exercise] of session.exercises.entries()) {
    const exercisePath = `${path}.exercises[${exerciseIndex}]`;
    validateId(exercise.id, exercisePath);
    requireString(exercise.name, `${exercisePath}.name`);
    requireString(exercise.target, `${exercisePath}.target`);
    requireString(exercise.instructions, `${exercisePath}.instructions`, true);

    if (session.type === "standard") {
      if (!Number.isInteger(exercise.sets) || exercise.sets < 1) {
        fail(`${exercisePath}.sets deve essere un intero maggiore di zero`);
      }
      if (
        exercise.optionalSets !== undefined &&
        (!Number.isInteger(exercise.optionalSets) || exercise.optionalSets < 1)
      ) {
        fail(`${exercisePath}.optionalSets deve essere un intero maggiore di zero`);
      }
      requireString(exercise.rest, `${exercisePath}.rest`, true);
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("workout-plan.json valido.");
