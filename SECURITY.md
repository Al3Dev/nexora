# Security policy
NEXORA is a hackathon prototype, not production-ready financial software.

Report suspected vulnerabilities privately through GitHub private vulnerability reporting if enabled, or contact the repository maintainer privately. Do not include credentials or customer data in public issues.

## Requirements
- TLS, server-only secrets, least privilege, MFA for privileged accounts.
- Explicit tenant isolation, input validation, parameterized queries and secure session handling.
- Document and verify provider webhook authenticity; reject mismatched payment details and deduplicate events.
- Do not collect card numbers, CVV or bank credentials.
- Restrict AI to authorized read-only aggregates; treat external text as untrusted.
- Audit dependencies, rotate exposed credentials, redact logs, and test backups and recovery.
- Review threat model and security tests before any live payment deployment.
