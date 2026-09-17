# AGENTS.md

## 1. Project Positioning

This project is a Preference-Aware Personal Tennis Agent.

The core problem is not simply finding available tennis courts. The user can usually describe what they care about, but may not be able to accurately quantify trade-offs between preferences.

Example user preference:

> I mainly want it to be cheap, ideally the following hour is also free, and before 13:00 or after 17:00 both work.

The system must not require the user to provide artificial numeric weights such as:

```json
{
  "price_weight": 0.4,
  "next_hour_weight": 0.35,
  "time_weight": 0.25
}
```

Instead, the system should use an LLM to interpret natural-language preferences into a strict structured Preference Profile. The agent then uses that profile to search, filter, compare, and rank real candidates.

This is not an automatic booking, checkout, or payment tool.

## 2. Current Verified SUSF Facts

SUSF booking uses PerfectMind.

The current verified flow is:

1. Log in to SUSF / PerfectMind manually.
2. Save Playwright `storageState`.
3. Open the real tennis booking page.
4. Detect Tennis Synthetic Court 4 / 5 / 6 from the DOM.
5. Read each court's real `data-facilityid` from the DOM.
6. Choose Court 4 / 5 / 6 separately.
7. Capture each court's real `FacilityAvailability` request.
8. Reuse the real request URL, method, headers shape, body shape, `serviceId`, and `durationIds`.
9. Query future availability with `duration=60`.
10. Normalize availability and calculate `nextHourAlsoAvailable`.

Verified one-time result:

- Court 4: 154 available start times
- Court 5: 140 available start times
- Court 6: 122 available start times
- Total: 416 available start times

Important:

- `facilityId` must continue to come from the real DOM. Do not hardcode it.
- `serviceId`, `durationIds`, CSRF/request verification tokens, and request shape must continue to come from the real page/request.
- SUSF adapter code lives in `packages/susf`.
- Do not reimplement PerfectMind Playwright logic inside the MCP server, agent, ranking package, or UI.
- PerfectMind availability uses start-time intervals, but current searches are for `duration=60`. A 06:15 availability means 06:15 can start a 60-minute booking, not that 06:15-06:30 is a 15-minute slot.

## 3. Preference Architecture

The product architecture adds two explicit preference layers:

1. Preference Interpreter
2. Preference Profile

The Preference Interpreter uses an LLM.

Input:

- User natural-language preference.

Output:

- A strict structured schema.
- Ordinal preference importance, not fake precise numerical weights.

Example Preference Profile:

```json
{
  "search_window_days": 7,
  "preferences": [
    {
      "feature": "price",
      "direction": "lower",
      "importance": "high",
      "type": "soft"
    },
    {
      "feature": "next_hour_free",
      "target": true,
      "importance": "high",
      "type": "soft"
    },
    {
      "feature": "start_time",
      "rule": {
        "before": "13:00",
        "after": "17:00"
      },
      "importance": "medium",
      "type": "soft"
    }
  ]
}
```

Allowed importance values:

- `hard`
- `high`
- `medium`
- `low`
- `uncertain`

If a preference relationship cannot be reliably inferred, use `"importance": "uncertain"`. Do not invent trade-offs the user did not express.

## 4. Hard Constraints vs Soft Preferences

Hard constraints are enforced by deterministic code.

Examples:

- Explicit user rule such as "I absolutely will not play in rain"
- Unavailable court

If a candidate violates a hard constraint:

```text
candidate -> reject
```

The LLM, agent, and ranker must not override hard constraints.

Soft preferences allow trade-offs.

Examples:

- Lower price
- `nextHourAlsoAvailable`
- Before 13:00 or after 17:00
- Better weather comfort
- Court surface or venue preference

Soft preferences may be considered by the LLM ranker, after hard filtering and deterministic candidate reduction.

## 5. Candidate Processing Pipeline

Do not put hundreds of raw SUSF availability records directly into an LLM prompt.

Use this pipeline:

```text
availability
  -> deterministic feature extraction
  -> hard filtering
  -> cheap deterministic pre-filter / dominance filtering
  -> narrowed candidates
  -> LLM ranking Top N
```

The LLM ranker should usually inspect about 10-30 high-quality candidates, not hundreds of raw availability rows.

Candidate Builder must compute factual attributes with code/API calls:

```json
{
  "venue": "SUSF",
  "court": "Court 4",
  "startTime": "2026-09-01T18:00:00",
  "durationMinutes": 60,
  "nextHourAlsoAvailable": true,
  "price": null,
  "preferredTime": true,
  "weather": null
}
```

Factual attributes must be calculated by code or authoritative APIs. The LLM must not guess facts from raw data.

## 6. LLM Ranker

The LLM Ranker handles only soft preference trade-offs.

Input:

- Structured Preference Profile
- Candidates that already passed hard constraints
- Candidate factual attributes

Output:

```json
{
  "ranked": [
    {
      "candidate_id": "candidate_A",
      "rank": 1,
      "reasons": [
        "价格较低",
        "下一小时仍为空",
        "属于偏好时间"
      ]
    }
  ]
}
```

The LLM Ranker must not:

- Modify factual fields
- Modify availability
- Ignore hard constraints
- Invent price
- Modify the user's Preference Profile
- Automatically execute booking, checkout, or payment

If two candidates cannot be compared reliably from the current Preference Profile, the ranker should mark uncertainty or the agent should ask the user. Do not force a made-up preference.

## 7. Deterministic Fallback Ranking

The main product supports LLM reasoning over soft preference trade-offs, but a deterministic fallback is required for reliability.

Use fallback when:

- LLM API fails
- LLM call times out
- LLM returns malformed structured output

Fallback may use ordinal priority:

```text
high > medium > low
```

This fallback is not a claim about the user's true utility function. It is a reliability path only.

## 8. Preference Memory

MVP memory should be simple: JSON, local storage, or SQLite.

Do not implement vector memory, fine-tuning, or complex online learning for the first version.

At minimum, persist:

1. `user_stated_preferences`
2. `interpreted_preference_profile`
3. `timestamp`
4. `version`

Future records may include:

```json
{
  "agent_recommendation": "candidate_A",
  "user_final_choice": "candidate_B"
}
```

This can later support analysis of whether user choices align with stated preferences.

MVP behavior:

- Record preference and choice data.
- Do not automatically update durable user preferences without evals.
- Do not let a model permanently rewrite user preference from one interaction.

## 9. Agent Responsibility

The agent is responsible for orchestration, not basic data calculation.

Example goal:

```text
find next tennis session
  -> load Preference Profile
  -> call SUSF availability
  -> build candidates
  -> extract deterministic features
  -> call Weather
  -> enforce hard constraints
  -> reduce candidate set
  -> call preference ranker
  -> return Top 3
```

If candidate quality is poor, the agent may:

- Expand the date range
- In a future version, search other venues
- Ask whether the user wants to relax a soft preference

The agent must not compute factual availability, price, or weather status with language-model guesses.

## 10. MCP Architecture

Formal architecture:

```text
Tennis Agent
      |
      v
  MCP Client
      |
      v
Tennis MCP Server
      |
      +-- get_susf_availability
      +-- get_tennis_weather
      +-- evaluate_candidates
              |
              v
       domain/core modules
```

SUSF adapter remains independent:

```text
MCP
  -> packages/susf
  -> Playwright / PerfectMind
```

Do not reimplement SUSF Playwright logic inside the MCP server.

Preference Interpreter can remain an agent-internal module. It does not need to be forced behind an MCP tool.

## 11. Suggested Directory Structure

Do not perform meaningless restructuring just to match this shape. Use it as the target architecture when adding real functionality.

```text
tennis-agent/
  apps/
    web/

  packages/
    susf/
      src/
        session.mjs
        availability.mjs
        index.mjs

    core/
      src/
        candidates.mjs
        constraints.mjs
        features.mjs
        types.mjs

    preferences/
      src/
        schema.mjs
        interpreter.mjs
        store.mjs

    ranking/
      src/
        llm-ranker.mjs
        fallback-ranker.mjs

    mcp-server/
      src/
        index.mjs
        tools/

    agent/
      src/
        agent.mjs
        state.mjs
        prompts.mjs

  config/
    preferences.example.json

  eval/
    preference-cases.json
    ranking-cases.json

  scripts/
    login-susf.mjs
    check-susf.mjs
    recommend.mjs

  .auth/
  .env
  AGENTS.md
  README.md
```

## 12. Eval Plan

Add at least two MVP eval families.

A. Preference Interpretation Eval

Input:

> 我主要想便宜，最好后一小时没人，13点前或者17点以后都行。

Expected interpretation:

- `price` -> `high`
- `next_hour_free` -> `high`
- preferred time -> `medium`
- No fixed numerical weights required

B. Ranking Eval

Input:

- Candidate set
- Preference Profile

Checks:

- Hard constraint violations = 0
- Factual hallucination = 0
- Candidate IDs are not modified
- Ranking explanations use real candidate attributes
- Clearly dominated candidate should not rank first

Future:

C. Preference Alignment Eval

Compare:

- agent recommendation
- actual user choice

MVP records this data only. It does not implement automatic preference training.

## 13. Security Boundaries

Never commit or print secrets.

Forbidden to commit:

- `.auth/storageState.json`
- Cookie values
- `PMAuth`
- CSRF or request verification token values
- Google OAuth tokens
- API keys
- `.env`

Forbidden actions:

- Automatic payment
- Automatic checkout
- Booking without explicit future product approval
- CAPTCHA bypass
- MFA bypass
- Credential collection in scripts

SUSF login must remain manual. Scripts may open a browser and save Playwright `storageState`, but must not read, store, or print usernames/passwords.

## 14. Third-party Service Protection / SUSF Request Discipline

SUSF / PerfectMind is a third-party production system. Development and verification must avoid unnecessary repeated live access.

Default verification should prefer:

- Unit tests
- Mocks and fixtures
- Cached availability
- Saved non-sensitive synthetic or sample data

Do not treat a real SUSF smoke test as the default validation step after every code change.

These commands may access the same real SUSF backend:

```bash
npm run susf:check
npm run candidates
npm run preview
```

Do not run them consecutively unless there is a clear need. A single real availability fetch should be reused as much as possible across:

- Candidate Core
- Preference preview
- Ranking
- Future Weather enrichment

Do not fetch SUSF again merely because execution has moved into a different pipeline stage.

SUSF adapter caching requirements:

- Availability should default to a 10-minute cache TTL.
- Identical queries within the TTL should prefer cached results.
- Cache bypass must be explicit and reserved for user-requested live refreshes.

Real SUSF request behavior must be conservative:

- Avoid high-concurrency bursts.
- Query courts with low concurrency or sequential requests.
- Do not add aggressive concurrency to speed up tests.
- Do not use meaningless retry loops.

Retry behavior must be finite:

- Use at most a small number of retries for transient network failures.
- Do not keep retrying on `401`, `403`, `429`, or unusual anti-abuse responses.
- Stop immediately and report abnormal status responses.

Do not perform:

- Load testing
- Stress testing
- Endpoint fuzzing
- High-frequency polling
- Rate-limit bypass
- Anti-bot or CAPTCHA bypass
- Simulation of many users

Price trace, network investigation, and similar spikes are read-only investigation tools. Once their facts are verified, they must not become part of the normal recommendation path.

`npm test` must remain offline by default and must not access SUSF.

Real integration smoke tests should be separated from unit tests. Prefer explicit naming such as:

```bash
npm test
npm run smoke:susf
```

In future Agent/MCP runtime behavior, repeated user recommendation requests should reuse recent availability when appropriate instead of fetching SUSF again for every natural-language message.

If it is unclear whether an operation could have side effects on a third-party production system, default to not executing it and investigate read-only first.

Booking, hold, checkout, and payment automation remain forbidden.

## 15. MVP Scope

MVP must support:

1. Persistent natural-language preference
2. LLM to structured Preference Profile
3. SUSF Court 4 / 5 / 6 availability
4. `nextHourAlsoAvailable`
5. Weather
6. Candidate feature extraction
7. LLM soft-preference ranking
8. Deterministic fallback
9. Top 3 recommendation
10. MCP Server
11. Minimal CLI/Web UI
12. Basic eval
13. README and architecture diagram

Explicitly out of scope:

- Multi-agent architecture
- Automatic booking
- Payment
- Social scheduling
- Complex memory
- Fine-tuning
- Preference model training
- Central venue integration
- Mobile app
- Elaborate UI

## 16. Product Principles

Do not assume the user knows their exact preference weights.

Design principles:

- Explicit constraints -> deterministic enforcement
- Describable but hard-to-quantify preferences -> LLM interpretation
- Soft preference trade-offs -> bounded LLM reasoning
- Actual user choice -> feedback signal
- Remaining uncertainty -> ask the user

Most important principle:

> LLMs handle ambiguity. Code guarantees factual correctness and safety.

## 17. Done Definition

The user first sets a durable preference:

> 我比较闲。我主要想便宜，最好我订一小时后后面也没人，13点前或者17点以后都行。

The system saves a Preference Profile.

After that, the user only needs:

```bash
npm run recommend
```

or can click:

```text
Find my next court
```

The system automatically:

```text
load preferences
  -> SUSF availability
  -> candidate feature extraction
  -> Weather
  -> hard filter
  -> LLM preference ranking
  -> Top 3
```

Final Top 3 should display at least:

- Court
- Date / time
- Availability
- `nextHourAlsoAvailable`
- Price, only when truly fetched
- Weather
- Reasons
- Uncertainty, when present

Do not require the user to repeat fixed preferences every time.
