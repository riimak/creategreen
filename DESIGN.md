---
name: BIOS Multi-level Platform
description: Calm operational dashboard for prediction, data quality, SLA, and blockchain traceability.
colors:
  platform-bg: "oklch(96.8% .008 155)"
  surface-base: "oklch(92.5% .012 155)"
  surface-card: "oklch(98.8% .006 155)"
  border-muted: "oklch(84.5% .018 155)"
  text-primary: "oklch(23% .03 155)"
  text-muted: "oklch(50% .026 155)"
  command-blue: "oklch(55% .17 245)"
  signal-green: "oklch(58% .16 150)"
  warning-amber: "oklch(68% .15 70)"
  fault-red: "oklch(58% .18 25)"
  relay-pink: "oklch(61% .18 345)"
typography:
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 700
    lineHeight: 1.2
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.74rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "8px"
  md: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "16px"
  result-panel:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "12px"
  chip-ok:
    backgroundColor: "{colors.signal-green}"
    textColor: "{colors.signal-green}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
---

# Design System: BIOS Multi-level Platform

## 1. Overview

**Creative North Star: "Grid Station"**

The visual system should feel like an energy infrastructure control station in a bright review room: steady, legible, and quietly alive. It is a product dashboard for reviewers and operators, not a marketing surface and not a crypto spectacle.

The system uses restrained color, compact typography, tonal layering, and visible but controlled motion. Real-time updates should read like instrument signals: a trace, a pulse, a timestamp, a relay state. They should never make the layout flicker or imply activity that did not happen.

**Key Characteristics:**

- Calm operational density.
- Clear state labels before visual drama.
- Subtle live signal accents.
- Audit-friendly blockchain details.
- Reviewer-friendly hierarchy.

## 2. Colors

The palette is a restrained light operational palette with green-tinted neutrals, one primary live-state accent, and separate semantic colors for warning, fault, relay, and command actions.

### Primary

- **Signal Green**: Used for healthy liveness, successful relay, EKG trace, and confirmed real-time activity. It must stay rare enough to mean "working now."

### Secondary

- **Command Blue**: Used for primary controls, active selections, and focused affordances. It should not compete with Signal Green for live-state meaning.
- **Relay Pink**: Used only for blockchain relay emphasis and Stealth-related pulse states.

### Tertiary

- **Warning Amber**: Used for stale, partial, at-risk, and SLA warning states.
- **Fault Red**: Used for failed, unavailable, or error states.

### Neutral

- **Platform Background**: The full dashboard background. It should read as quiet, lightly tinted operational paper, not pure white.
- **Surface Base**: Inset readout panels and code-like result containers.
- **Surface Card**: Main operational panels.
- **Border Muted**: Quiet separators and card outlines.
- **Text Primary**: Main readable UI text.
- **Text Muted**: Secondary labels, descriptions, and technical metadata.

### Named Rules

**The Signal Scarcity Rule.** Signal Green is reserved for live, healthy, or confirmed state. Do not use it as decoration.

**The Honest Status Rule.** Warning Amber and Fault Red must always be paired with explicit labels. Never rely on color alone.

## 3. Typography

**Display Font:** Inter, system-ui, sans-serif
**Body Font:** Inter, system-ui, sans-serif
**Label/Mono Font:** ui-monospace, SFMono-Regular, Consolas, monospace

**Character:** The type system is utilitarian and native-feeling. It favors trust, compact labels, and stable data readouts over personality.

### Hierarchy

- **Title** (700, 1rem, 1.2): Panel titles and high-level section labels.
- **Body** (400, 0.82rem, 1.5): Descriptions, helper text, and explanatory copy.
- **Label** (700, 0.7rem, 1.2): Chips, status tags, and compact state labels.
- **Mono** (400, 0.74rem, 1.45): Payloads, hashes, tx ids, service endpoints, and other audit details.

### Named Rules

**The Readout Rule.** Use monospace only for technical evidence: hashes, payloads, transaction ids, timestamps, and compact logs.

**The Reviewer Rule.** Keep explanatory copy short and factual. A reviewer should understand the panel without reading a paragraph.

## 4. Elevation

The system uses tonal layering rather than heavy shadow. Depth comes from darker page background, slightly lighter cards, inset result panels, quiet borders, and temporary update glows. Shadows are not a default styling primitive.

### Shadow Vocabulary

- **Update Glow** (`0 0 0 1px rgba(34,197,94,.18), 0 0 32px rgba(34,197,94,.12)`): Used only during a real data update pulse.

### Named Rules

**The Tonal Layer Rule.** Static surfaces are separated by lightness and border, not drop shadows.

**The Pulse Is State Rule.** Glow appears only when a service update changes visible state.

## 5. Components

### Buttons

The dashboard is read-only for normal operation, so buttons should be rare. When present for API testing or fallback controls, they use Command Blue, familiar rounded shape (8px), and clear focus states.

### Chips

- **Style:** Pill-shaped labels with muted tinted backgrounds and semantic text color.
- **State:** `ok`, `warn`, and `err` labels are always textual. The color supports the word, it does not replace it.

### Cards / Containers

- **Corner Style:** Soft operational rounding (12px).
- **Background:** Surface Card over Platform Background.
- **Shadow Strategy:** Flat by default. Temporary update glow only on meaningful data changes.
- **Border:** One-pixel muted border.
- **Internal Padding:** 16px for cards, 12px for result panels.

### Inputs / Fields

Inputs are not part of the read-only dashboard surface. If configuration fields are reintroduced, they should use Surface Base, muted border, 8px radius, visible focus outline, and standard keyboard behavior.

### Navigation

The dashboard currently uses a single-page top header. Navigation should remain minimal until there are multiple operational views. Do not add decorative nav just to fill space.

### Live Signal

The EKG-style trace is a signature state indicator. It should animate only when a meaningful backend event changes the dashboard state. Heartbeats may update the timestamp, but should not flood the activity stream.

### Relay Flow

The Prediction to Blockchain Relay to Stealth flow strip is a compact system map. It should pulse by stage when that stage receives fresh state: prediction cycle, blockchain event, Stealth tx or block visibility.

## 6. Do's and Don'ts

### Do:

- **Do** show operational truth first: stale data, mock mode, unconfigured RPC, duplicates, and relay failures must be visible.
- **Do** pair every color state with text.
- **Do** keep real-time motion subtle, short, and tied to a real state change.
- **Do** use Signal Green only for healthy live state.
- **Do** preserve audit context for blockchain events: source, payload, hash, tx id, relay mode, and verification state.
- **Do** respect reduced motion by keeping state legible without animation.

### Don't:

- **Don't** use crypto casino or neon hype aesthetics.
- **Don't** drift into a generic dark SaaS dashboard look.
- **Don't** create an overanimated NOC wallboard that distracts from data.
- **Don't** make it feel like a dry academic prototype with no product polish.
- **Don't** use marketing landing page language or layout.
- **Don't** animate the whole layout or repaint stable panels on heartbeat.
- **Don't** hide uncertainty, missing data, mock mode, or unconfigured RPC behind optimistic visuals.
- **Don't** use colored side-stripe borders, gradient text, or decorative glassmorphism.
