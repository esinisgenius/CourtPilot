# TennisAgent

A preference-aware tennis court search agent for Sydney that can diagnose failed searches and safely replan while deterministic code protects hard constraints.

## Problem

Tennis court search is awkward because availability is fragmented across providers, and the user's real preferences are often fuzzy or conflicting: price, travel time, preferred courts, time windows, weather, calendar conflicts, and whether two continuous hours are available. A fixed filter workflow can easily return no result without knowing which preference to relax next.

TennisAgent treats explicit constraints as rules and soft preferences as trade-offs. The LLM helps interpret and reason about ambiguous preferences, while code owns factual checks, filtering, bounded replanning, and termination.

## Example

User preference:

> Tomorrow after 5 PM, prefer Court 4/5/6, cheaper if possible, ideally two consecutive hours.

Compact replanning trace:

```text
Observation:
preferred courts unavailable

Evaluation:
NO_FEASIBLE_CANDIDATES

Failure diagnosis:
preferred_courts_unavailable

Replanning action:
INCLUDE_NONPREFERRED_COURTS

New observation:
a feasible non-preferred court becomes available

Final:
SATISFACTORY
```

This is a behavioral pattern covered by the agent eval suite. The README does not claim a specific live court, price, or provider result for that example.

## Agent Architecture

```text
User Preference
      |
      v
Search / Observe
      |
      v
Hard Constraint Filter
      |
      v
Rank Candidates
      |
      v
Evaluate Result
      |
      v
Failure Diagnosis
      |
      v
Bounded LLM Replanner
      |
      v
Deterministic Executor
      |
      v
Re-observe
```

Deterministic code:

- enforces hard constraints before ranking;
- computes factual candidate attributes from provider/API data;
- defines the legal replanning action contract;
- executes bounded state changes such as expanding radius or including non-preferred courts;
- controls max iterations and termination;
- provides deterministic ranking fallback when the LLM ranker fails.

LLM components:

- interpret natural-language preferences into a structured Preference Profile;
- reason over soft-preference trade-offs and failure context;
- rank hard-filtered candidates when a ranker provider is available;
- select among bounded legal replanning actions where appropriate.

The LLM is not allowed to freely relax explicit hard constraints, invent missing facts, create candidates, or modify factual availability.

## Failure-Aware Replanning

The replanner uses failed constraints and observation context instead of defaulting to generic expansion. Supported examples include:

```text
preferred_courts_unavailable
  -> INCLUDE_NONPREFERRED_COURTS

no_availability_in_time_window
  -> bounded SHIFT_TIME_WINDOW while preserving hard temporal boundaries
```

The execution step is deterministic: each accepted action must be in the legal contract and must change search state or stop/ask the user.

## Safety Invariants

- Explicit hard constraints are never silently relaxed.
- Hard-invalid candidates are filtered before ranking.
- Missing facts are not treated as constraint violations.
- Replanning actions must come from a bounded legal action contract.
- Replanning must change state or observation instead of looping in place.
- The agent terminates after bounded iterations.
- Booking, checkout, and payment automation are out of scope.

## Evaluation

Current verified results:

```text
npm test: 284 passed, 0 failed
npm run eval:agent-behavior: 14 passed, 0 failed
```

The behavior regression suite covers:

- initially satisfactory results;
- mild soft-preference violations;
- missing consecutive two-hour slots;
- preferred court unavailability;
- hard time-window constraints;
- hard transit limits;
- missing accessibility facts;
- ranking trade-offs;
- ranker fallback;
- observation changes after replanning;
- max-iteration termination;
- ambiguous cases requiring `ASK_USER` / `STOP`;
- hard filtering before ranking.

These evals are regression coverage for a bounded scenario set, not proof of universal production reliability.

## Tech Stack

- Node.js ES modules
- Playwright for authenticated SUSF / PerfectMind availability access
- OpenAI structured output for preference interpretation and optional LLM ranking/replanning
- Open-Meteo weather enrichment
- Apple Calendar EventKit and Google Calendar FreeBusy adapters
- Google Maps Platform adapters for location, venue, and travel-time facts
- Node's built-in test runner

## Repository Structure

```text
packages/agent        bounded replanning loop, evaluator, actions, search scope
packages/core         candidate features, hard constraints, enrichment contracts
packages/preferences  Preference Profile schema, interpreter, local store
packages/ranking      LLM ranker interface and deterministic fallback ranker
packages/susf         SUSF / PerfectMind availability adapter
packages/weather      Open-Meteo adapter and cache
packages/calendar     Apple EventKit and Google FreeBusy adapters
packages/maps         location, venue discovery, travel time, saved play areas
packages/bookable     provider adapter
packages/sportlogic   provider adapter
packages/intrac       provider adapter
packages/unified-bookings provider adapter
eval                  preference and agent behavior eval runners/cases
tests                 offline unit and behavior tests
scripts               local CLI checks and demos
```

## Quick Start

```bash
npm install
npm test
npm run eval:agent-behavior
```

Useful local commands:

```bash
npm run preference:set -- "我主要想便宜，最好后一小时没人，13点前或者17点以后都行"
npm run preference:show
npm run feasible:synthetic
```

Provider checks exist for SUSF, calendar, weather, maps, and other adapters, but some call real external services and may require local auth or API keys. For SUSF, login is manual:

```bash
npm run susf:login
npm run susf:check
```

`preference:set` uses OpenAI structured JSON output and requires `OPENAI_API_KEY`. Calendar, Maps, and live provider checks require their own local configuration. Runtime secrets and personal data under `.auth/`, `.env`, `data/preferences.json`, `data/saved-play-areas.json`, and `output/` are ignored.

## Limitations

- This is search and recommendation assistance, not autonomous booking or payment.
- Provider coverage is limited and uneven; verified SUSF availability uses the SUSF / PerfectMind path, while other provider packages are adapter-specific.
- Live availability depends on external provider reliability, authentication state, and provider page/API changes.
- Maps-discovered venues are venue-level alternatives unless reconciled to a verified availability source.
- Candidate-level price mapping is still limited; the system should only display price when it is actually fetched.
- Behavior evals cover a bounded set of scenarios.
- Preference interpretation, LLM ranking, and LLM replanning remain provider-dependent, with deterministic fallbacks where implemented.
