import fs from "node:fs";
import { loadPolicy } from "../src/policy.js";
import { route } from "../src/router.js";

type Case = {
  id: string;
  prompt: string;
  expected_alias: string;
  expected_intent: string;
};

const policy = loadPolicy("config/policy.json");
const lines = fs.readFileSync("tests/cases.jsonl", "utf8").trim().split("\n");

let fails = 0;

for (const line of lines) {
  const testCase = JSON.parse(line) as Case;
  const decision = route(testCase.prompt, policy);
  const ok = decision.chosenAlias === testCase.expected_alias && decision.intent === testCase.expected_intent;

  if (!ok) {
    fails += 1;
    console.error(
      `FAIL ${testCase.id} expected alias=${testCase.expected_alias} intent=${testCase.expected_intent}`
    );
    console.error(
      `     got      alias=${decision.chosenAlias} intent=${decision.intent} reasons=${decision.reasonCodes.join(",")}`
    );
  }
}

if (!fails) {
  console.log(`All ${lines.length} routing cases passed.`);
}

process.exit(fails ? 1 : 0);
