#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { validateWorkoutPlan } = createRequire(import.meta.url)("../assets/plan-validation.js");
try {
  const plan = JSON.parse(readFileSync("data/workout-plan.json", "utf8"));
  const errors = validateWorkoutPlan(plan);
  if (errors.length) {
    console.error(`Validazione non riuscita:\n${errors.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("workout-plan.json valido.");
  }
} catch (error) {
  console.error(`Validazione non riuscita: ${error.message}`);
  process.exitCode = 1;
}
