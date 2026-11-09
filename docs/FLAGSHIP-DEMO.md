# Making Code Explain Itself: Insurance Premium Assessment

This demonstration follows one insurance application through a calculation and decision. Its purpose is to show how Mnemosyne connects ordinary values, package calls, and an AI assessment in one runtime provenance DAG. It is not an insurance pricing recommendation or a production underwriting model.

The example is deterministic: `assessRiskFixture()` returns a fixed GPT-5-shaped response, so the diagram and output can be reproduced without credentials or network calls. Replace that fixture with a real model request wrapped in `__t.ai()` when demonstrating a live provider call.

## Run it

Install the example packages at the documented versions:

```sh
npm install --no-save lodash@4.17.21 date-fns@2.30.0
npx ts-node --transpile-only examples/insurance-premium.ts
```

The instrumented implementation is in [`examples/insurance-premium.ts`](../examples/insurance-premium.ts). The source imports `lodash/round` and `date-fns/differenceInCalendarDays`; the package import metadata resolver should resolve their installed versions. Package calls remain opaque: Mnemosyne records their inputs, outputs, source locations, and durations without tracing library internals.

## Business inputs and calculation

```json
{
  "age": 47,
  "vehicleValue": 45000,
  "accidentsLast5Years": 2,
  "annualMileage": 18000,
  "state": "NJ"
}
```

The demonstration uses an age factor of `0.9`, vehicle factor of `45`, and accident factor of `1.24`:

```text
basePremiumRaw = 420 + 45 × 18 × 0.9 × 1.24 = 1323.96
basePremium = lodash.round(1323.96, 2) = 1323.96
policyDays = date-fns.differenceInCalendarDays(2027-01-01, 2026-01-01) = 365
mileageAdjustedPremium = lodash.round(1323.96 × 1.12 × (365 / 365), 2) = 1482.84
AI risk score = 0.63
risk adjustment = 1 + 0.63 × 0.2 = 1.126
state adjustment = 1.08
premium = lodash.round(1482.84 × 1.08 × 1.126, 2) = 1803.25
```

The decision rules are applied to the observed inputs: more than three accidents denies; an AI risk score above `0.8` requires manual review; otherwise the application is approved. The example application is approved.

## Example result

```json
{
  "approved": true,
  "status": "approved",
  "premium": 1803.25,
  "riskScore": 0.63,
  "policyDays": 365,
  "reasons": [
    "AI risk level: medium",
    "Accidents in lookback period: 2",
    "State rating factor: 1.08"
  ]
}
```

## Provenance DAG

The diagram below is the value-flow view. Package and AI nodes are opaque computation boundaries: their input edges show what they consumed and their outgoing edges show what their returned value influenced.

```mermaid
graph TD
  age["age = 47"] --> ageFactor["ageFactor = 0.9"]
  vehicleValue["vehicleValue = 45000"] --> vehicleFactor["vehicleFactor = 45"]
  accidents["accidentsLast5Years = 2"] --> accidentFactor["accidentFactor = 1.24"]
  vehicleFactor --> raw["basePremiumRaw = 1324.08"]
  ageFactor --> raw
  accidentFactor --> raw
  raw --> lodashBase["lodash@4.17.21.round(1323.96, 2) = 1323.96"]
  lodashBase --> base["basePremium = 1323.96"]
  start["policyStart = 2026-01-01"] --> dateFns["date-fns@2.30.0.differenceInCalendarDays = 365"]
  end["policyEnd = 2027-01-01"] --> dateFns
  dateFns --> days["policyDays = 365"]
  mileage["annualMileage = 18000"] --> mileageFactor["mileageFactor = 1.12"]
  base --> mileageCalc["base × mileage × duration"]
  mileageFactor --> mileageCalc
  days --> mileageCalc
  mileageCalc --> lodashMileage["lodash.round = 1482.84"]
  lodashMileage --> adjusted["mileageAdjustedPremium = 1482.84"]
  application["application fields"] --> prompt["risk assessment prompt"]
  prompt --> ai["AI: openai / gpt-5\nscore 0.63 · 123 tokens"]
  ai --> riskScore["aiRisk = 0.63"]
  accidents --> accidentRule["accidents > 3? false"]
  riskScore --> aiRule["aiRisk > 0.8? false"]
  accidentRule --> status["status = approved"]
  aiRule --> status
  riskScore --> riskFactor["riskAdjustment = 1.126"]
  state["state = NJ"] --> stateFactor["stateAdjustment = 1.08"]
  adjusted --> finalCalc["adjusted × state × risk"]
  stateFactor --> finalCalc
  riskFactor --> finalCalc
  finalCalc --> lodashFinal["lodash.round = 1803.25"]
  lodashFinal --> premium["premium = 1803.25"]
  status --> output["decision.approved = true"]
  premium --> output
  riskScore --> output
```

## Example runtime trace

IDs below are representative of a trace where the module input bindings are recorded first. Exact IDs can vary with Babel output and tape version; use the IDs printed by the run when querying a live trace.

| ID | Kind | Label | Inputs | Value |
|---:|---|---|---|---|
| 12 | `op` | `basePremiumRaw` calculation | vehicle, age, accident factors | `1323.96` |
| 13 | `package` | `lodash.round` | raw base premium, `2` | `1323.96` |
| 21 | `package` | `date-fns.differenceInCalendarDays` | policy end, policy start | `365` |
| 34 | `package` | `lodash.round` | mileage-adjusted amount, `2` | `1482.84` |
| 42 | `ai` | `openai.gpt-5` | prompt/application fields | `score: 0.63` |
| 49 | `op` | `aiRisk > 0.8` | AI score, `0.8` | `false` |
| 58 | `package` | `lodash.round` | final premium, `2` | `1803.25` |
| 61 | `output` | `assessApplication.premium` | final premium | `1803.25` |

An AI node should retain its model, prompt provenance input, token usage, latency, and metadata. For production traces, avoid putting sensitive raw prompt content into persisted/exported node metadata; the current runtime records the prompt and response, so a hash-only/redaction option is appropriate before sharing real customer data.

## MCP walkthrough

The outputs below are examples of the intended result shape for this trace. Use the actual node IDs from a live run for ID-based tools.

### `showPackages()`

```json
[
  { "packageName": "lodash", "version": "4.17.21", "usageCount": 3 },
  { "packageName": "date-fns", "version": "2.30.0", "usageCount": 1 }
]
```

### `showPackageUsage("lodash")`

```json
{
  "packageName": "lodash",
  "functionsUsed": ["round"],
  "callCount": 3,
  "inputs": [1323.96, 2, 1482.84, 2, 1803.2520672, 2],
  "outputs": [1323.96, 1482.84, 1803.25]
}
```

### `showAIUsage()`

```json
[
  { "provider": "openai", "model": "gpt-5", "callCount": 1, "tokenConsumption": 123 }
]
```

### `explainResult("premium")`

The live MCP query should resolve the named premium binding and return its ancestry: application inputs → base premium → package rounding → date-based duration and mileage adjustment → AI risk assessment → underwriting rules and state/risk multipliers → final `lodash.round` output. In the current MCP implementation, `explainResult` accepts a numeric node ID; the name-based form shown here requires the MCP schema to support resolving a label or the caller should pass the printed node ID (for example, `61`).

### `findDependencies("premium")`

Expected package ancestors: `lodash.round` and `date-fns.differenceInCalendarDays`. The final premium is produced by lodash; date-fns contributes upstream through policy duration and the mileage adjustment.

### `findAIInfluence("premium")`

Expected AI ancestry: the single `openai / gpt-5` assessment with score `0.63`. It flows through `riskAdjustment` into `premium`.

### `simulatePackageRemoval("lodash")`

Expected impact: three observed package calls and the traced values downstream of those calls, including `basePremium`, `mileageAdjustedPremium`, `premium`, and the final decision object. This is trace impact, not a proof that lodash can be safely removed from every code path.

### `simulateAIRemoval("gpt-5")`

Expected impact: the traced AI score, risk adjustment, premium, and decision output. The application has no independently computed alternative AI score in this example, so the correct alternative-path result is empty; Mnemosyne should not invent a replacement value or recompute underwriting behavior.

## MCP compatibility note

The current server uses numeric `resultId` for `explainResult`, `findDependencies`, and `findAIInfluence`, and the current package-removal simulation takes a package name. To run the exact user-facing calls above, the MCP tool schemas need a follow-up that accepts either a numeric node ID or a resolvable label for result queries, while keeping the `premium` label unambiguous in this single-result trace. The AI removal query currently filters by model name; the requested `"gpt-5"` input matches that schema.
