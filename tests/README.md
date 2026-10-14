# Planned verification

This directory contains test plans only. There are no executable tests, test framework dependencies or claims of passing application behavior.

| Directory | Intended checks |
| --- | --- |
| `boundaries` | Context ownership, forbidden imports, provider isolation and dependency cycles. |
| `integration` | PostgreSQL/queue transactions, worker access, result acceptance, recovery and deletion. |
| `scenarios` | End-to-end business decisions and observable effects with fake providers and Discord. |

Add focused executable checks with the behavior they verify. Use real PostgreSQL/pg-boss for concurrency and transaction guarantees, deterministic fakes for provider/Discord outcomes, and a test guild for external API behavior. Keep fixtures attributable and tenant-scoped. Do not add tests that merely assert this scaffold's placeholder text.
