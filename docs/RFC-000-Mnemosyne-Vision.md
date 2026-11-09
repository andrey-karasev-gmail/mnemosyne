# RFC-000

# Mnemosyne

## Making Code Explain Itself

### From Runtime Tracing to Explainable Software

Author: Andrey Karasev

Status: Active

---

# Purpose

Mnemosyne is a TypeScript runtime provenance engine.

Its goal is to help humans and AI understand:

- how values were produced
- how calculations evolved
- how decisions were reached

Mnemosyne is intended primarily for:

- debugging
- reverse engineering
- business rule investigation
- calculation auditing
- AI-assisted software understanding

---

# Core Principle

Software can explain itself if execution provenance is captured.

Traditional observability answers:

"What happened?"

Mnemosyne answers:

"Why did it happen?"

---

# Current Architecture

Source Code

↓

Transpiler

↓

Runtime Execution

↓

Provenance DAG

↓

MCP

↓

Human / AI Investigation

---

# Provenance Model

Current Nodes:

- input
- variable
- operation
- function
- return

Planned Nodes:

- package
- ai

Future Nodes (not committed):

- service
- database
- api

---

# Packages

External package usage must become visible.

Example:

price
quantity

↓

lodash.round()

↓

result

Questions:

- Which package produced this value?
- How many package functions participated?
- Can package usage be reduced?

Package internals remain opaque.

Full source expansion is future work.

---

# AI

AI calls are treated as provenance participants.

Example:

Prompt

↓

GPT-5

↓

Response

↓

Business Rule

↓

Decision

Questions:

- Which model influenced the decision?
- Which outputs depend on AI?
- What changes if the AI call is removed?

---

# Non Goals

Mnemosyne is NOT:

- a workflow engine
- an agent framework
- OFMM
- a consensus engine
- a planning system
- an observability replacement

---

# Relationship To OFMM

OFMM and Mnemosyne solve different problems.

OFMM:

How should experts collaborate?

Mnemosyne:

How was this result produced?

Mnemosyne may be used by OFMM.

OFMM does not define Mnemosyne.

---

# Target User Questions

Why is this value 64.76?

Where did this variable come from?

Which calculation created this output?

Which package contributed?

Which AI call influenced this result?

What is the complete causality chain?

---

# Vision

Move software from:

Runtime Tracing

to

Explainable Software