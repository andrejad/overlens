# How the app is tested

- **REQ_TEST_001** — `make test-focus AREA=<area>` runs just that area's Go, Vitest and tagged Playwright tests, in about 15 seconds or less.
- **REQ_TEST_002** — `make test` runs everything: Go unit and integration tests (against a temporary SQLite file), Vitest, and the full Playwright browser suite. Nothing is "done" until it is green.
- **REQ_TEST_003** — Playwright is a real development dependency with a `playwright.config.ts`.
- **REQ_TEST_004** — Each test is named after the requirement ID it proves. Every behaviour requirement has at least one test, at the cheapest layer that proves it (normally one to three, not one per layer); the hard rules keep their dedicated tests; requirements about documents, packaging or process are checked in review, not by tests. *(Decision 2026-10-11.)*
- **REQ_TEST_015** *(withdrawn — decommissioned 2026-10-11: superseded by REQ_TEST_004 (one test per behaviour at the cheapest layer, decision 2026-10-11))*

**Never touching real data**

- **REQ_TEST_005** — *Hard rule.* No test ever touches the development or production database. Every run builds a fresh temporary one from `schema.sql`.
- **REQ_TEST_006** — The test helper refuses to run if the database path is the dev or production one, or if it is asked to delete something outside its own temporary folder.
- **REQ_TEST_007** — Cleanup always happens, even if a test fails or crashes, and any server the tests started is stopped.
- **REQ_TEST_008** — Tests set `LOG_PREFIX=test` so their output never goes into the real `app.log`.

**Test data (none is fixed)**

- **REQ_TEST_009** *(withdrawn — replaced by REQ_TEST_016)* — One shared seed program used to feed all tests.
- **REQ_TEST_010** *(withdrawn — replaced by REQ_TEST_019)* — A self-test used to check the shared sample data.
- **REQ_TEST_011** — From the first release on, each released database layout is kept under `testdata/schemas/vN.sql` as table definitions only, with no stored rows, and a test per version creates rows in every table that holds user data, proves the upgrade works and leaves those rows untouched. Before the first release there are none: `schema.sql` is the only layout. *(Decided 2026-10-11: the pre-release layouts were dropped.)*
- **REQ_TEST_016** — *Hard rule.* The test suite contains no fixed dataset. Each test creates only the data it needs, using builders that go through the app's own store code (Go) or real API (browser). Builders have valid defaults and return named handles; tests never hardcode ids or row counts.
- **REQ_TEST_017** — Tests use days relative to a clock they control, never absolute dates, and calculate expected values from the data they created instead of writing literal dates or counts.
- **REQ_TEST_018** — The hard rules (no overlap at every zoom level, dependency order, the 3-year cap) are also tested on randomly generated roadmaps from a seeded random number generator. A failure prints the seed, and `TEST_SEED=<n>` replays it exactly.
- **REQ_TEST_019** — A quick self-test checks that the builders produce valid data: no dependency loops, dates in range.
- **REQ_TEST_020** — Tests never use the shipped sample data or the development data. One separate test checks that the shipped sample file loads and satisfies the roadmap invariants.

**The two tests that run first**

- **REQ_TEST_012** — *Hard rule.* The no-overlap browser test (every roadmap screen of the real app, every zoom level) runs before every other browser test, and if it fails no other browser test runs.
- **REQ_TEST_013** — Browser helpers that measure elements skip them by whether they are really visible on screen, never just by the `hidden` attribute.
- **REQ_TEST_014** — A config test checks that a missing `bootstrap_admin_user` gives a non-zero exit and an ERROR line.
- **REQ_TEST_021** — The company view has tests that the trace hides unrelated roadmap items, that same-named workstreams merge into one row, that the saved orders survive a reload, and that no two blocks overlap in any company row (REQ_TEST_012).
- **REQ_TEST_022** *(withdrawn — CI was added and reverted on 2026-10-11; recorded here because the ID was used)*
