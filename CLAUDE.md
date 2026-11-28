# Claude Code — NEXORA
@AGENTS.md

## Project context
Hackatón México 2026. Prioritize an end-to-end sandbox payment demo: POS order → Pey/CoDi → confirmed payment → inventory and metrics → Grok explanation.

## Working agreement
Read docs/ARCHITECTURE.md and SECURITY.md before changing payment or authentication code. Inspect existing files before editing. State assumptions, keep scope small, write tests and report what was actually executed. Do not deploy, spend money or access real customer data without explicit authorization. Never invent test results.

Frontend: `apps/web` (`npm run build`). API: `apps/api` (`npm test`, `npm run typecheck`, `npm run build`). Run the API tests after any change to `apps/api` or `database/migrations`.
