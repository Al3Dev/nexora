# NEXORA development instructions
- Use TypeScript strict mode; React/Vite frontend and modular NestJS API.
- PostgreSQL is authoritative. Enforce tenant membership and object authorization on every server operation; use database RLS as defense in depth.
- Never commit secrets, real customer data or card details. Never expose server keys through VITE_ variables.
- Calculate money in integer minor units; validate prices and quantities server-side.
- Verify payment notifications using documented provider mechanisms; reconcile amount, currency, merchant and order reference. Process idempotently in a database transaction.
- Grok receives minimized, authorized aggregates only; no write or payment permissions. Never treat model output as authoritative financial calculations.
- Do not invent provider endpoints or claim integrations work without testing against official documentation.
- Use synthetic fixtures, tests for cross-tenant access, duplicate events and invalid inputs. Review dependency changes and document limitations.
- Keep changes small, use feature branches and pull requests. Never bypass security checks to make demos work.
