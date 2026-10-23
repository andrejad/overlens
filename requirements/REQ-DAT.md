# What is stored, and the rules about it

**The database itself**

- **REQ_DAT_001** — `schema.sql` in the repo root is the single definition of the database, and it is applied the first time the app starts.
- **REQ_DAT_002** — On later starts, the database is brought up to date only by adding things (new columns or tables). A table holding user data is never dropped and recreated.
- **REQ_DAT_003** — The database has tables for teams, roadmaps (one per team, REQ_DAT_032), workstreams, deliverables, deliverable–workstream links, deliverable icons, roadmap item links (`roadmap_item_links`, REQ_DAT_031), icon labels, dependencies (one table for all four kinds of edge, REQ_DAT_007), milestones, users, sessions, the audit log, the company workstream order, the company team order, and a small settings table (`meta`).

**Teams and roadmaps**

- **REQ_DAT_004** — A team's name and its short tag are each unique, ignoring capitals. The tag is 2 to 4 capital letters. The team's default color is a hex color.
- **REQ_DAT_020** — A team can be deleted only while its roadmap holds no roadmap items (deliverables or milestones); its roadmap and that roadmap's workstreams are deleted with it, in the same step. Nothing else is ever deleted along with a team.
- **REQ_DAT_008** *(withdrawn — decommissioned 2026-10-11: there is one roadmap per team, so no active/archived switch; replaced by REQ_DAT_032)*
- **REQ_DAT_009** — A roadmap's start and end are worked out from its data (earliest and latest deliverable or milestone date) and updated on every create, delete or date change. Nobody types them in.
- **REQ_DAT_015** — *Hard rule.* A roadmap never spans more than 3 years from its earliest to its latest date.
- **REQ_DAT_017** — The app has no fiscal-year idea. Years are calendar years.
- **REQ_DAT_022** *(withdrawn — replaced by REQ_DAT_025)*
- **REQ_DAT_025** *(withdrawn — decommissioned 2026-10-11: there are no archived roadmaps any more, REQ_DAT_032)*
- **REQ_DAT_024** *(withdrawn — decommissioned 2026-10-11: a roadmap is deleted only together with its team, REQ_DAT_020)*
- **REQ_DAT_023** — A roadmap always has at least one workstream. One called "General" is created with it, and its last remaining workstream can never be deleted.
- **REQ_DAT_032** — *Hard rule.* Every team has exactly one roadmap. It is created with the team in the same step (title = the team's name, one workstream "General", REQ_DAT_023), can be renamed (REQ_FE_001), and is deleted only with the team (REQ_DAT_020). There is no active/archived state and no second roadmap; the database enforces one roadmap per team. *(Decided 2026-10-11.)*
- **REQ_DAT_026** — *Hard rule.* The row a deliverable occupies inside each of its workstreams, and the row of each milestone, is stored — so it is the same after a reload and for every viewer, and only changes when a user drags the roadmap item there.

**Deliverables**

- **REQ_DAT_010** — A roadmap item's status is one of planned, in progress, done or at risk. A person sets it; the app never works it out from the dates.
- **REQ_DAT_011** — When a roadmap item stops being "at risk", its risk note is cleared.
- **REQ_DAT_012** — Every deliverable belongs to at least one workstream.
- **REQ_DAT_005** — Which workstream is a deliverable's main one is worked out (the one listed first), never stored.
- **REQ_DAT_013** — Every deliverable keeps its own color. The team's default color is only what a new deliverable starts with.
- **REQ_DAT_018** — Changing a team's default color never recolors existing deliverables; it is only what new deliverables start with (REQ_DAT_013). *(Changed 2026-10-11: the "apply to all existing deliverables" option was never offered on screen and is removed.)*
- **REQ_DAT_019** — A deliverable in the shipped sample or the development data (REQ_IMP_006) that has no color gets its team's default color.
- **REQ_DAT_014** — A roadmap item (deliverable or milestone) can have any number of labelled web links, under the same rules for both. Adding, changing or removing a link is one entry in the audit log.
- **REQ_DAT_031** — The links of deliverables and milestones are stored in one table, `roadmap_item_links` (the kind and id of the roadmap item, label, URL, position, created time). Deleting a roadmap item deletes its links.
- **REQ_DAT_016** — Dates are exact days, never rounded to a week or month. Weeks run Monday to Sunday.
- **REQ_DAT_021** — Moving a deliverable to another team keeps everything about it: its id, dates, status, risk note, description, icons, links, responsible person, color and dependencies.

**Links between records**

- **REQ_DAT_006** — Workstreams of different teams that have the same name are treated as one row in the company view. The order people choose for those rows is saved.
- **REQ_DAT_007** — A dependency is stored as "from" (the one that must finish first) and "to" (the one that waits), each end a roadmap item given by its kind and id, in one table for all four combinations. The pair is unique, and deleting either roadmap item deletes the dependency.
- **REQ_DAT_027** — The database also keeps a saved team order for the company view (one row per team, a position, removed with the team). A team with no row is simply not yet ordered. Adding it is an additive upgrade of an existing database (REQ_DAT_002).
- **REQ_DAT_028** — Names (teams, roadmaps, workstreams, deliverables, milestones, imported names), the team tag, icon labels and link labels are trimmed the same way by the server and the browser: leading and trailing Unicode White_Space characters, U+FEFF (byte-order mark) and U+200B (zero-width space) are removed. Characters in the middle of a name are left alone. The server's `cleanName` is the reference; the frontend has one `trimName()` that every name field uses instead of `trim()`. A shared table of strings (no-break space, U+0085, U+FEFF, U+200B, U+2028, ideographic space, ordinary space and tab) is run through both and must give the same answers.
- **REQ_DAT_029** — A milestone has a description: rich text like a deliverable's, empty by default. Moving a milestone to another team (REQ_API_013) and the sample and development data (REQ_IMP_006) keep it.
- **REQ_DAT_030** — A milestone has an owner (responsible person, empty by default), a status and a risk note, exactly like a deliverable: REQ_DAT_010 and REQ_DAT_011 apply to it (status is planned by default). Moving a milestone to another team and the sample and development data keep all three and its links. A milestone also has links, like a deliverable (REQ_DAT_014). On screen: REQ_FE_024, 032, 040, 100.
