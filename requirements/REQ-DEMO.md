# Demo data shipped with the app

**What it is**

- **REQ_DEMO_001** — The app ships with a small demo company: five teams (Product, Mobile, Data Engineering, AI, Infrastructure), three workstreams shared by all teams (Customer Experience, AI & Data, Platform & Reliability), four deliverables per team (twenty in all) and five milestones in total. Milestones belong to the teams' roadmaps and sit in these same workstreams, just like deliverables; there is no workstream of their own for them. *(Changed 2026-10-16: was two teams and four deliverables.)*
- **REQ_DEMO_002** — The demo is a company file (REQ_IMP_006), embedded in the binary.
- **REQ_DEMO_003** — All demo dates are relative to the day it is loaded, so it never looks stale.
- **REQ_DEMO_004** — The demo file always satisfies the roadmap rules: no overlaps, dependency order respected, no loops, span within 3 years.
- **REQ_DEMO_012** — Between them, the twenty demo deliverables show every kind of metadata: a description with formatting, a responsible person, a custom color, icon labels, links, several workstreams (so one deliverable also appears as a copy), and statuses that include one "At risk" with its risk note. The five demo milestones each have an owner and show a status too: one planned, one in progress and one "At risk" with its risk note.
- **REQ_DEMO_013** — The demo shows dependencies: at least one within a team and at least one across teams, forming a chain of at least three deliverables a user can trace, and at least one dependency with a milestone end. The milestones sit in different workstreams.
- **REQ_DEMO_019** — *(2026-10-16)* The demo and the development company are laid out for the company view: its dates run from about three months before the day it is loaded to about nine months after it, so all five teams and all their roadmap items show on one screen. Every deliverable in them is one to four sprints long (a sprint is two weeks: 14, 28, 42 or 56 days). It has enough dependencies to demo showing dependencies and tracing them on the company view (across teams, through a milestone), and few enough not to clutter it.

- **REQ_DEMO_020** — *(2026-10-21, decision)* In the sample and in the development company, responsible persons are made-up people written with first and last name, never a job title: every team's deliverables are shared between two or three people, every milestone has a named owner (REQ_DEMO_012, REQ_DEMO_016), and at least one deliverable that is not done and leads to a milestone has no owner, so the trace's "without owner" count and the Accountable list's "No owner" group (REQ_DEP_036, REQ_DEP_039) show in the demo.

**How it gets there (decided at deployment time)**

- **REQ_DEMO_005** — *(decided 2026-10-04)* The sample company is created once, at start-up, when the database has no team, no roadmap and no `meta` row `sample_created`, so a user who opens a freshly delivered installation finds a small working example, not empty screens. The config key `sample_data` (default `true`) switches it off. The same transaction writes the `meta` row, so a later restart, or deleting everything by hand, never creates it again (REQ_DEMO_007). The sample stays minimal: it is the content of REQ_DEMO_001, 012 and 013, loaded from the embedded file through the company-file loader (REQ_IMP_004, REQ_IMP_006).
- **REQ_DEMO_006** *(withdrawn — the app has no "Load demo company" button)*
- **REQ_DEMO_007** — *Hard rule.* Whatever mechanism is chosen must never change or overwrite existing data, and must never create the sample data again once it has been created or once any team or roadmap exists.
- **REQ_DEMO_008** *(withdrawn — sample rows are not tagged; they are ordinary data)*

**After that it is the user's data**

- **REQ_DEMO_009** *(withdrawn — the app has no "Remove demo data" action)*
- **REQ_DEMO_010** *(withdrawn — see REQ_DEMO_014)*
- **REQ_DEMO_011** *(withdrawn — see REQ_DEMO_015)*
- **REQ_DEMO_014** — The sample data is ordinary data. Users rename, edit and delete it by hand like anything else, with the same confirmations, and nothing marks it as special or protects it.
- **REQ_DEMO_015** — When the sample data is created, that is one audit-log entry that records the counts.

**Data used while developing the app (never shipped, never used by tests)**

- **REQ_DEMO_016** — While the app is being built, a development company is used that is bigger than the sample: the same five teams (Product, Mobile, Data Engineering, AI, Infrastructure) and three shared workstreams, but six deliverables per team (30 in all), one roadmap per team (REQ_DAT_032), 6 milestones (sitting in the same workstreams as the deliverables, as in the sample) and 17 dependencies (five of them to a milestone, two from one, several across teams). It follows the layout rules of REQ_DEMO_019, and its milestones each have an owner and a status (one at risk with a risk note).
- **REQ_DEMO_017** — The development company is kept in the repository as `dev/company.json`, as a company file (REQ_IMP_006), with dates relative to the day it is loaded. It is separate from the shipped sample data and separate from test data.
- **REQ_DEMO_018** — `make dev-data` runs `roadmap -dev-data dev/company.json`, which loads the development company into the development database. It refuses unless the config's `environment` key is `development` (default `production`), the database is not under the test scratch folder, and the database has no team yet. The development config sets `sample_data: false`, otherwise the first start would create the sample and the loader would refuse. `--reset` first wipes the database, after printing what it will delete and waiting for the word `yes` typed in. A Go test loads both the sample file and `dev/company.json` through the company-file loader, so a broken file fails `make test`.
