# Proposed architecture
Browser (React/Vite) → NestJS API → PostgreSQL. Server adapters connect Pey and xAI. Supabase Auth is the proposed identity provider.

## Modules
Payments, POS, catalog, inventory, CRM, analytics, authentication and audit. Start with a modular monolith.
## Payment lifecycle
Create an order and amount on the server. Request a payment via Pey using its documented API. Keep the order pending until authoritative verification. Reconcile amount/currency/merchant/reference, deduplicate provider events, and atomically record sale and stock movement. Handle retries and reconciliation failures explicitly.
## Financial metrics
Persist cost at sale time. Gross profit = net sales minus cost of goods sold; gross margin = gross profit divided by net sales when nonzero. Use integer centavos and document tax/refund handling.
## AI
Provide Grok with authorized aggregated metrics and time windows. AI explains calculated figures, flags uncertainty, and cannot initiate transactions or modify records.
## Scope
QR and payment links first. NFC tags may open links; NFC card acceptance is a separate future integration. No real payment processing before provider and security checks.
