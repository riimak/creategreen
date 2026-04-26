# Product

## Register

product

## Users

Primary users are BIOS team members and project reviewers evaluating whether the delivered platform credibly covers production Mars2 data consumption, partner export obligations, predictive analysis, data-quality monitoring, and blockchain traceability.

Secondary users are operators and developers who need to understand whether the services are running, whether data is fresh enough to trust, what prediction artifacts exist, and whether important events were anchored or are ready to be relayed to Stealth.

Users usually arrive in a review or monitoring context: they need confidence quickly, without learning a custom interface or decoding decorative visuals.

## Product Purpose

The product demonstrates and supports a multi-level platform for tracking meteo data and electricity production. It connects three related areas: partner export tooling, a live Mars2 production-data dashboard, and always-on assignment services for prediction, SLA/data quality, and blockchain event anchoring.

Success means a reviewer or operator can immediately see:

- production BIOS/Mars2 data is being consumed correctly
- export files follow the partner contract
- prediction services run continuously and expose useful artifacts
- stale or missing data is visible, not hidden
- blockchain relay behavior is traceable and auditable
- the implementation is credible without overengineering the project

## Brand Personality

Calm, operational, trustworthy.

The interface should feel like a serious engineering control surface: clear enough for project reviewers, disciplined enough for operators, and transparent enough for developers. It should communicate that the system is alive, but it should not perform for attention.

Tone is concise and factual. Use labels that explain operational state directly: `ready`, `stale`, `within SLA`, `at risk`, `confirmed`, `duplicate`, `mock`, `json-rpc`.

## Anti-references

Avoid:

- crypto casino or neon hype aesthetics
- generic dark SaaS dashboard styling
- overanimated NOC wallboards that distract from data
- dry academic prototypes with no product polish
- marketing landing page language or layout
- animations that suggest activity when no meaningful state changed
- hiding uncertainty, missing data, mock mode, or unconfigured RPC behind optimistic visuals

## Design Principles

1. Show operational truth first. Surface freshness, SLA, missing data, and relay mode clearly, even when the status is degraded.
2. Make liveness legible, not loud. Real-time updates should be visible through restrained pulses and timestamps, without flickering the interface.
3. Preserve auditability. Every blockchain/event element should expose enough context to understand source, payload, hash, transaction id, and verification state.
4. Separate demo from production honestly. Mock mode is valid for local demos, but it must be labeled as mock. Real RPC capability should appear only when configured.
5. Keep reviewer flow simple. A stakeholder should understand the story in one pass: Mars2 data, prediction/service health, data quality, blockchain traceability.

## Accessibility & Inclusion

Target WCAG AA for contrast, focus visibility, and keyboard access. Do not rely on color alone for status; pair color with text labels. Support reduced motion by disabling decorative pulses and keeping state changes readable without animation. Use stable layouts that do not jump during real-time updates.
