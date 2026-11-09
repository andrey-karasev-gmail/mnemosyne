/**
 * Mnemosyne flagship demonstration: an explainable insurance premium decision.
 *
 * Run with lodash 4.17.21 and date-fns 2.30.0 installed. The AI response is a
 * deterministic fixture so the example is repeatable and needs no API key.
 * Replace assessRiskFixture with a real provider call wrapped in `__t.ai()` to
 * trace an actual model invocation.
 */
import { round } from "lodash";
import { differenceInCalendarDays } from "date-fns";

// Mnemosyne installs this shared tape in the instrumented execution context.
declare const __t: import("../src/runtime").Tape;

interface Application {
  age: number;
  vehicleValue: number;
  accidentsLast5Years: number;
  annualMileage: number;
  state: string;
}

interface RiskAssessment {
  riskLevel: "low" | "medium" | "high";
  score: number;
  usage?: { total_tokens: number };
}

interface PremiumDecision {
  approved: boolean;
  status: "approved" | "manual-review" | "denied";
  premium: number;
  riskScore: number;
  policyDays: number;
  reasons: string[];
}

const application: Application = {
  age: 47,
  vehicleValue: 45000,
  accidentsLast5Years: 2,
  annualMileage: 18000,
  state: "NJ",
};

const policyStart = "2026-01-01";
const policyEnd = "2027-01-01";

function assessRiskFixture(prompt: string): Promise<RiskAssessment> {
  // Deterministic stand-in for an LLM response. This keeps the walkthrough
  // reproducible while still exercising Mnemosyne's AI provenance node.
  return Promise.resolve({
    riskLevel: "medium",
    score: 0.63,
    usage: { total_tokens: 123 },
  });
}

async function assessApplication(input: Application): Promise<PremiumDecision> {
  const ageFactor = input.age < 25 ? 1.35 : 0.9;
  const vehicleFactor = input.vehicleValue / 1000;
  const accidentFactor = 1 + input.accidentsLast5Years * 0.12;
  const basePremiumRaw = 420 + vehicleFactor * 18 * ageFactor * accidentFactor;
  const basePremium = round(basePremiumRaw, 2);

  const policyDays = differenceInCalendarDays(new Date(policyEnd), new Date(policyStart));
  const mileageFactor = input.annualMileage > 15000 ? 1.12 : 1;
  const durationFactor = policyDays / 365;
  const mileageAdjustedPremium = round(basePremium * mileageFactor * durationFactor, 2);

  const prompt = [
    "Evaluate insurance application risk.",
    `Age: ${input.age}`,
    `Vehicle value: ${input.vehicleValue}`,
    `Accidents in last five years: ${input.accidentsLast5Years}`,
    `Annual mileage: ${input.annualMileage}`,
    `State: ${input.state}`,
  ].join("\n");
  const risk = await __t.ai(() => assessRiskFixture(prompt), {
    provider: "openai",
    model: "gpt-5",
    prompt,
    temperature: 0,
    metadata: { purpose: "insurance-risk-assessment", mode: "deterministic-demo" },
  });
  const aiRisk = risk.score;

  let status: PremiumDecision["status"] = "approved";
  if (input.accidentsLast5Years > 3) {
    status = "denied";
  } else if (aiRisk > 0.8) {
    status = "manual-review";
  }

  const stateAdjustment = input.state === "NJ" ? 1.08 : 1;
  const riskAdjustment = 1 + aiRisk * 0.2;
  const premiumBeforeRound = mileageAdjustedPremium * stateAdjustment * riskAdjustment;
  const premium = round(premiumBeforeRound, 2);
  const approved = status === "approved";
  const reasons = [
    `AI risk level: ${risk.riskLevel}`,
    `Accidents in lookback period: ${input.accidentsLast5Years}`,
    `State rating factor: ${stateAdjustment}`,
  ];

  return {
    approved,
    status,
    premium,
    riskScore: aiRisk,
    policyDays,
    reasons,
  };
}

async function main(): Promise<void> {
  __t.reset();
  const decision = await assessApplication(application);
  console.log(JSON.stringify(decision, null, 2));
  console.log(`Trace nodes: ${__t.nodes.length}`);
  console.log(`Package nodes: ${__t.nodes.filter((node) => node.kind === "package").length}`);
  console.log(`AI nodes: ${__t.nodes.filter((node) => node.kind === "ai").length}`);
}

void main();
