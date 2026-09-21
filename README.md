# CourtPilot 

CourtPilot is a preference-aware tennis court recommendation agent for Sydney.

It is built for a very common tennis-player problem: you do not just want "any available court". You want the court that best fits a messy bundle of real preferences: close enough, not too expensive, playable at the right time, maybe two hours in a row, maybe a familiar venue, maybe acceptable weather. Most booking sites force that into rigid filters. CourtPilot lets the player describe what matters in natural language, then turns that into a structured search and ranking workflow.

This is a search and recommendation product. It does not book courts, hold courts, check out, or pay.

## Why This Exists

Finding a tennis court is deceptively annoying:

- Availability is scattered across multiple providers and booking systems.
- A good result depends on trade-offs, not a single filter.
- Players often know their preference in words, but not in numeric weights.
- "No result" is rarely the end of the story; the product should know whether to widen location, relax preferred courts, shift time, or ask the user.
- Live booking providers are production systems, so the agent must be conservative and cache-aware.

Example preference:

> 我主要想便宜，最好我订一小时后后面也没人，13点前或者17点以后都行。

CourtPilot should understand this as:

- cheaper is important;
- the next hour also being free is important;
- before 13:00 or after 17:00 is preferred;
- these are mostly soft preferences unless the user states a hard rule.

The user should not need to write fake weights like `price = 0.4`, `time = 0.25`.

## Product Flow

```text
Natural-language preference
        |
        v
Preference Interpreter
        |
        v
Structured Preference Profile
        |
        v
Provider availability adapters
        |
        v
Candidate feature extraction
        |
        v
Hard constraint filtering
        |
        v
Deterministic reduction
        |
        v
LLM or fallback ranking
        |
        v
Top recommendations with reasons
```

The product separates two kinds of user intent:

- Hard constraints: deterministic rules. If a candidate violates one, it is rejected before ranking.
- Soft preferences: trade-offs. These are ranked after factual candidate data has been computed.

That split is the core product bet: LLMs handle ambiguity; code protects facts, constraints, and safety.

## What The Agent Returns

The recommendation slate is designed to explain the trade-off, not just show a slot:

- court and venue;
- date, start time, and duration;
- whether the next hour is also available;
- price only when actually fetched;
- weather and travel facts when available;
- reasons grounded in candidate attributes;
- uncertainty when the current facts are incomplete.

The agent can also diagnose failed searches. For example, if preferred courts are unavailable, it can try non-preferred courts as a bounded replanning action. If a hard time window makes every result invalid, it should not silently relax that rule.

## Technical Implementation

### Preference Interpretation

`packages/preferences` turns natural-language text into a strict Preference Profile. The OpenAI path uses structured output, and the schema preserves ordinal importance such as `hard`, `high`, `medium`, `low`, and `uncertain`.

The interpreter is not asked to invent precise utility weights. If the relationship is unclear, it marks uncertainty rather than making up a preference.

### Availability And Candidate Facts

`packages/susf` owns the SUSF / PerfectMind integration. The adapter:

- uses manual login with Playwright storage state;
- discovers real court and facility identifiers from the page/DOM;
- captures the provider request shape from the real booking flow;
- queries availability for Court 4 / 5 / 6 without hardcoding provider tokens;
- normalizes slots into candidate-ready availability records;
- computes `nextHourAlsoAvailable` from actual adjacent availability.

Other provider packages are present for broader venue coverage:

- `packages/bookable`
- `packages/sportlogic`
- `packages/intrac`
- `packages/unified-bookings`

`packages/core` then builds candidate facts, applies hard constraints, evaluates eligibility, and enriches candidates with supported factual attributes.

### Weather, Location, And Travel

`packages/weather` uses Open-Meteo with caching.

`packages/maps` contains location resolution, canonical Sydney play areas, radius handling, venue discovery, travel-time checks, and accessibility facts. These facts are used as inputs to constraints and ranking; the LLM should not guess them.

### Ranking

`packages/ranking` supports two paths:

- LLM slate ranking for soft-preference trade-offs, using only the supplied Preference Profile and candidate facts.
- Deterministic fallback ranking when the LLM provider fails, times out, or returns invalid structured output.

The ranker is not allowed to modify candidate facts, create fake availability, invent price, or override hard constraints.

### Replanning

`packages/agent` orchestrates the recommendation loop:

- interpret request and durable preferences;
- choose provider scope from location and venue signals;
- observe candidates;
- filter hard-invalid results;
- rank the remaining slate;
- evaluate result quality;
- diagnose failure;
- execute a bounded legal replanning action or stop.

Supported replanning behavior includes cases such as including non-preferred courts or bounded time-window adjustment. Replanning must terminate and must change state; it cannot loop indefinitely.

## Local Demo

```bash
npm install
npm run demo
```

Then open:

```text
http://127.0.0.1:4174/
```

The demo UI lives in `apps/web`. The `/api/recommend` route calls the real recommendation service, so live results may require local auth, API keys, and provider availability. The checked-in UI can still be inspected as a product prototype without making a booking.

## Useful Commands

```bash
npm test
npm run eval:preferences
npm run eval:agent-behavior
npm run feasible:synthetic
```

Preference workflow:

```bash
npm run preference:set -- "我主要想便宜，最好后一小时没人，13点前或者17点以后都行"
npm run preference:show
```

SUSF manual login and live check:

```bash
npm run susf:login
npm run susf:check
```

Live provider checks can access third-party services. Prefer offline tests, fixtures, and cached data during normal development.

## Repository Map

```text
apps/web                  mobile-first demo UI
packages/agent            recommendation orchestration and bounded replanning
packages/core             candidate construction, features, constraints, enrichment
packages/preferences      Preference Profile schema, interpreter, local store
packages/ranking          LLM slate ranker and deterministic fallback ranker
packages/susf             SUSF / PerfectMind Playwright adapter
packages/weather          Open-Meteo adapter and cache
packages/maps             location, venue, travel time, saved play areas
packages/bookable         provider adapter
packages/sportlogic       provider adapter
packages/intrac           provider adapter
packages/unified-bookings provider adapter
eval                      preference, location, parser, H5, and behavior evals
tests                     offline unit and behavior tests
scripts                   local CLI checks, login, demo, and diagnostics
```

## Security And Safety Boundaries

CourtPilot intentionally avoids high-risk automation:

- no automatic booking;
- no checkout or payment;
- no CAPTCHA or MFA bypass;
- no credential collection;
- no committing `.auth`, `.env`, cookies, CSRF tokens, API keys, or personal preference data.

SUSF login remains manual. The scripts may save Playwright `storageState`, but they must not read, print, or store usernames and passwords.

Real provider access should be conservative:

- avoid repeated live fetches when cached data is sufficient;
- do not load test, stress test, fuzz, or poll production booking systems;
- do not retry indefinitely;
- stop on abnormal provider responses such as `401`, `403`, `429`, or anti-abuse signals.

## Current Limitations

- This is recommendation assistance, not an autonomous booking agent.
- Provider coverage is uneven, and each booking system has its own reliability risks.
- Candidate-level price should only be displayed when the system actually fetched it.
- Maps-discovered venues may be venue-level alternatives unless reconciled with a verified availability source.
- LLM interpretation, ranking, and replanning depend on provider availability and configured API keys.
- Evals cover bounded scenarios; they are regression coverage, not a guarantee of universal production correctness.

## Product Direction

The MVP target is simple:

1. Save the user's durable tennis preferences.
2. Fetch verified availability where supported.
3. Build factual candidates.
4. Enforce hard constraints.
5. Rank soft trade-offs.
6. Show the top three choices with reasons and uncertainty.

The longer-term direction is preference learning from actual user choices, but the current product records feedback only. It does not automatically rewrite durable preferences from a single interaction.
