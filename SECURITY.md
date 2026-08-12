# Security policy

ZeroGate is a pre-release reference prototype for transactional safety around consequential agent actions. It is not production-ready, and no released version currently carries a production-support or security-maintenance guarantee.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository: open the **Security** tab, select **Advisories**, then choose **Report a vulnerability**. Do not disclose suspected vulnerabilities, secrets, customer data, exploit details, or sensitive logs in a public issue or pull request.

If private reporting is unavailable, open a public issue containing only a request for a private contact channel. Do not include vulnerability details in that issue.

Include, when safe and relevant:

- the affected commit, route, package, or component;
- reproduction steps or a minimal proof of concept;
- the security impact and any known preconditions;
- whether credentials, personal data, tenant boundaries, approvals, receipts, or ledger integrity may be affected; and
- a safe way to contact you privately.

The maintainer will handle reports on a best-effort basis, avoid public disclosure before a fix is available, and coordinate credit with the reporter. This prototype does not promise a response-time SLA, bounty, or legal safe harbor.

## Scope priorities

Reports involving approval binding, canonicalization, tenant isolation, secret handling, provider callbacks, reconciliation, receipt integrity, event ordering, evidence redaction, migrations, or the deployment supply chain receive the highest priority.

## Supported versions

Only the latest default-branch revision is considered for security fixes. Historical commits, generated artifacts, demonstration integrations, and prerelease snapshots are unsupported. A security fix or passing scanner result does not change the project's pre-release status.
