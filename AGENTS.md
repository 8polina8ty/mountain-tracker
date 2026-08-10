<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->


# Mountain Tracker — Project Instructions

## Project Goal

This is an existing mountaineering and mountain exploration web application.

The current goal is to modernize the UI/UX and introduce high-quality animations while preserving all existing functionality.

The application must evolve into a premium modern outdoor exploration platform rather than being rewritten from scratch.

## Core Technology

The project uses technologies including:

- Next.js
- React
- TypeScript
- Supabase
- MapLibre GL
- GeoJSON / GPX geographic data

Before making assumptions about the architecture, inspect the actual project files and dependencies.

## Critical Safety Rule

Preserving existing functionality is the highest priority.

Never rewrite working application logic solely for visual reasons.

Do not perform large uncontrolled rewrites.

Do not delete, rename, move, or replace major files unless explicitly requested.

Do not refactor unrelated code while implementing UI changes.

When uncertain about existing behavior, inspect the code instead of assuming.

## Development Workflow

Work incrementally.

For significant changes:

1. Inspect the relevant files and dependencies.
2. Explain the proposed change.
3. Identify possible risks.
4. Modify only the files required for that step.
5. Run appropriate TypeScript, lint, or build checks.
6. Fix errors introduced by the change before continuing.
7. Do not automatically continue into another major phase.

Large redesign tasks must be divided into small logical phases.

## MapLibre

The interactive mountain map is a core feature of the product.

Do not replace MapLibre unless explicitly requested.

Preserve existing functionality including:

- mountain markers
- mountain clustering
- altitude-based colors
- mountain search
- altitude filtering
- visible mountain counts
- mountain selection
- map navigation
- climbed mountain state
- Supabase mountain loading
- GeoJSON functionality
- GPX routes and tracks

Avoid unnecessary React re-renders in map-related components.

Do not apply expensive animations to the MapLibre map container.

UI controls around the map may be redesigned without changing the underlying map logic.

## Supabase

Treat Supabase and database behavior as sensitive application infrastructure.

Do not:

- modify the database schema
- drop or rename tables
- rename columns
- modify RLS policies
- change authentication behavior
- change existing API/data contracts
- rewrite working queries unnecessarily

unless explicitly requested.

Never expose, print, commit, or hardcode secrets, API keys, service-role keys, tokens, or environment variables.

## UI / UX Direction

The visual direction should feel like a premium modern mountaineering and outdoor exploration platform.

Prioritize:

- strong typography
- clear information hierarchy
- alpine-inspired visual identity
- modern map controls
- excellent spacing
- restrained rounded surfaces
- subtle depth
- high-quality responsive behavior
- clear mountain and route information
- professional outdoor aesthetics

Avoid making the application look like:

- a generic SaaS dashboard
- a crypto dashboard
- a gaming interface
- an overly futuristic sci-fi interface
- a cheap travel blog

Do not sacrifice usability or map readability for visual effects.

## Design System

Prefer reusable design primitives instead of duplicated page-specific styling.

Maintain consistency in:

- typography
- spacing
- colors
- border radius
- borders
- shadows
- buttons
- inputs
- cards
- badges
- navigation
- drawers
- modals
- tooltips
- loading states
- empty states

Before introducing a new UI library, inspect package.json and determine whether equivalent functionality already exists.

Do not install dependencies without explaining why they are needed.

## Animation

Animations should be subtle, responsive, and purposeful.

Good animation targets include:

- page transitions
- cards
- navigation
- drawers
- bottom sheets
- mountain detail panels
- search results
- filter controls
- buttons
- loading states
- route information

Prefer GPU-friendly animation of:

- opacity
- transform
- scale
- small translations

Avoid:

- excessive parallax
- constant floating animations
- large bouncing effects
- excessive blur animation
- animations that interfere with map interaction

Respect `prefers-reduced-motion`.

Performance is more important than decorative animation.

## Responsive Design

The application must work well on:

- desktop
- tablet
- mobile

Do not simply shrink desktop sidebars for mobile.

Where appropriate, consider mobile patterns such as:

- bottom sheets
- thumb-friendly controls
- large touch targets
- compact map overlays

Keep the map usable while displaying mountain information.

## Accessibility

Maintain strong text/background contrast.

Preserve keyboard accessibility.

Provide visible focus states.

Icons without visible labels must have accessible names.

Respect reduced-motion preferences.

## Code Quality

Use TypeScript.

Preserve and reuse existing types.

Avoid `any` unless genuinely necessary.

Reuse existing utilities and components instead of duplicating logic.

Keep UI logic separate from data/business logic where practical.

Do not introduce unnecessary dependencies.

## Git

The redesign work is being performed in a dedicated Git branch.

Do not:

- switch branches
- merge branches
- delete branches
- force reset
- rewrite Git history
- push to a remote repository

unless explicitly requested.

Do not create commits automatically unless explicitly requested.

## Required Redesign Order

Unless explicitly instructed otherwise, use this order:

1. Analyze the existing application.
2. Establish design direction and design tokens.
3. Improve the global application shell/navigation.
4. Redesign the main mountain map UI.
5. Redesign mountain cards and detail pages.
6. Improve search and filtering UI.
7. Introduce animations.
8. Improve mobile UX.
9. Review accessibility and performance.
10. Run final TypeScript, lint, and production build checks.

Do not implement all phases at once.

## First-Task Rule

When first asked to analyze this project:

DO NOT modify code.

DO NOT install packages.

DO NOT redesign components yet.

First inspect the project and report:

1. Current architecture.
2. Existing dependencies relevant to UI and animation.
3. Main UI/UX problems.
4. Components that are safe to redesign.
5. Components where changes carry higher risk.
6. Recommended design system.
7. Recommended animation strategy.
8. Recommended phased implementation plan.

Wait for approval before beginning implementation.
