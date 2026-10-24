#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { validateWorkoutPlan } = createRequire(import.meta.url)("../assets/plan-validation.js");
const { parseWorkoutCsv } = createRequire(import.meta.url)("../assets/plan-csv.js");
try {
  const path = process.argv[2] || "data/workout-plan.json";
  const source = readFileSync(path, "utf8");
  const plan = path.toLowerCase().endsWith(".csv") ? parseWorkoutCsv(source) : JSON.parse(source);
  const errors = validateWorkoutPlan(plan);
  if (errors.length) {
    console.error(`Validazione non riuscita:\n${errors.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`${path} valido.`);
  }
} catch (error) {
  console.error(`Validazione non riuscita: ${error.message}`);
  process.exitCode = 1;
}
