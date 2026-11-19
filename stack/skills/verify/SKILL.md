---
name: verify
description: Verify a change through appropriate real entry points and report evidence and remaining gaps.
---

# Verify

Run the checks required by the project and select additional tests that exercise the changed boundary. Prefer real CLI or application entry points when behavior depends on process, filesystem, or platform integration. Use isolated temporary data when tests mutate state.

Report commands and outcomes accurately. Distinguish simulated fixtures, static validation, and live or native-platform evidence; identify skipped checks and unresolved failures.
