# Dependencies between roadmap items

A dependency says "this roadmap item (a deliverable or a milestone) can't start until that one has finished". It can point across teams.

**The rules**

- **REQ_DEP_001** — A roadmap item can depend on one or more other roadmap items, including ones in another team's roadmap.
- **REQ_DEP_002** — A roadmap item can't depend on itself.
- **REQ_DEP_003** — A dependency that would form a loop is refused by the server (`409`) with the path that forms the loop, and the screen shows a message naming it.
- **REQ_DEP_004** — *Hard rule.* A dependent roadmap item can't start before the day after its prerequisite ends (a milestone starts and ends on its date, REQ_DEP_024). The server refuses any change that breaks this. The check reads only the edited roadmap item's own dependencies and the dates of their other ends, so its cost does not grow with the size of the database.

**Stopping people before they break the rule (all three ways of changing dates)**

- **REQ_DEP_005** — *Hard rule.* While dragging on a team roadmap, the start of a dependent (or its whole bar) stops at a dashed limit line rather than passing the earliest allowed day. Dragging a prerequisite's end later than a dependent's start stops the same way.
- **REQ_DEP_006** — *Hard rule.* The edit window and the side panel show the earliest allowed start (or latest allowed end) and won't save a date that breaks the rule.
- **REQ_DEP_007** — The dependency picker greys out roadmap items that can't be chosen and says why: they end too late, are already prerequisites, or would create a loop.
- **REQ_DEP_008** — The same searchable picker, covering every team, is in the side panel and in the full edit window, where the "Depends on" part (search box and list) is the last block. Every entry reads `<team tag> - <name>` (e.g. `ONB - Data migration`); entries are ordered by team tag (ignoring case), and within a team all milestones come first, then the deliverables, each alphabetically by name. A milestone entry carries the timeline's diamond in front of its label. There are no group headings. Greyed-out entries keep their reason.

**Arrows**

- **REQ_DEP_009** — Arrows leave the right edge of the prerequisite, run with right-angle bends, and end with an arrowhead at the left edge of the dependent.
- **REQ_DEP_010** — Arrows are faint by default and stand out on hover or when either end is selected.
- **REQ_DEP_011** — An arrow stays attached to a roadmap item while it is being dragged.
- **REQ_DEP_012** — If the other end is on another roadmap and not on screen, a small chevron badge on the edge shows it (its tooltip names the team and the roadmap item). The app never draws an arrow that points at nothing.
- **REQ_DEP_013** — A top-bar switch (REQ_FE_101), "Show dependencies" / "Hide dependencies", turns the arrows on and off.
- **REQ_DEP_014** — With arrows on, each deliverable appears once (in its main workstream only). The copies toggle is disabled (it keeps its normal label) and a tooltip explains why.
- **REQ_DEP_015** — Turning arrows off puts the copies setting back to what it was before.

**Drawing dependencies on the timeline**

- **REQ_DEP_016** — On a team roadmap, within about 6px of a bar's left or right edge the cursor becomes a two-sided arrow, and dragging there changes its dates.
- **REQ_DEP_017** — On hover a small round connector dot appears about 14px inside each edge, with a crosshair cursor. It never overlaps the resize zone.
- **REQ_DEP_018** — On a team roadmap, clicking a dot starts connect mode: a rubber-band arrow follows the pointer, clicking another bar creates the dependency, and Esc or a click on empty space cancels. The right dot means "this blocks…", the left dot "…depends on". The company view has no dots (REQ_FE_096); dependencies are changed there in the side panel.
- **REQ_DEP_019** — On a team roadmap an arrow can be deleted by selecting it and pressing Delete, or by clicking the × at its midpoint.
- **REQ_DEP_020** — Read-only visitors see the arrows but no dots, no connect mode and no picker.

**Tracing**

- **REQ_DEP_021** — "Trace dependencies" (a button at the left end of the company view's zoom row, after the team-roadmap button, shown once a roadmap item is selected, REQ_FE_066) shows everything it depends on and everything that depends on it, across all teams, and hides the rest. Empty workstream rows collapse, a banner reads "Tracing dependencies for: <name>", and a "Show all roadmap items" button brings everything back.
- **REQ_DEP_022** — The trace follows dependencies through every team's roadmap and shows a stats line "N prerequisites · M dependents · K unrelated items hidden" (roadmap items are deliverables and milestones, REQ_DEP_028). Starting a trace puts `#/company/trace/<kind>/<id>` in the address (REQ_DEP_028), and "Show all roadmap items" returns to the company view.

**Milestone dependencies (Phase 9)**

A **roadmap item** is a deliverable or a milestone. A dependency `from → to` says `to` can't happen until `from` has finished; each end is a roadmap item in any team's roadmap. All four combinations are allowed. A milestone's start and end are both its date.

- **REQ_DEP_023** — A milestone can depend on one or more roadmap items, and one or more roadmap items can depend on a milestone. A self-dependency is refused.
- **REQ_DEP_024** — *Hard rule.* The date rule (REQ_DEP_004) covers milestones: a dependent deliverable can't start before the day after its prerequisite milestone's date, and a dependent milestone's date must be strictly after its prerequisite's end (a deliverable's end or a milestone's date). The server refuses any change that breaks this with `409 date_order`; a milestone that falls on the day its prerequisite ends is refused.
- **REQ_DEP_025** — Loops are refused across the whole graph, including paths through milestones (REQ_DEP_003). The `409` names the path, each roadmap item marked as a deliverable or a milestone.
- **REQ_DEP_026** — Drag limits (REQ_DEP_005), the limits in the edit window and side panel (REQ_DEP_006) and the picker (REQ_DEP_007/008) work for milestones too: a milestone's date is limited by its prerequisites and dependents, and dragging it stops at the dashed limit line. The picker lists milestones together with deliverables in REQ_DEP_008's order, marked with a diamond, greyed out with a reason when not selectable.
- **REQ_DEP_027** — Arrows (REQ_DEP_009–012) run to and from a milestone marker, leaving the right edge of the prerequisite and ending at the left edge of the dependent. An arrow that leaves a milestone never takes a back-bend: when the dependent starts only a few pixels to the right of the diamond's tip, at any zoom, the arrow leaves from the diamond and runs straight towards the dependent. Connector dots (REQ_DEP_016–018) appear on milestones; read-only visitors see arrows and no dots (REQ_DEP_020).
- **REQ_DEP_028** — The trace (REQ_DEP_021/022) can start from a selected milestone and follows chains through both kinds. Milestones in the chain stay visible and the stats line counts roadmap items. The address is `#/company/trace/<kind>/<id>` (`kind` is `deliverable` or `milestone`).
- **REQ_DEP_029** — Deleting a milestone or a deliverable removes the dependencies that touch it. The audit entry names each removed dependency by both ends (REQ_AUD_003).
- **REQ_DEP_030** — Moving a deliverable or milestone across workstreams, or to another team, doesn't change its dependencies.
- **REQ_DEP_031** — The shipped sample and the development data carry milestone dependencies (REQ_IMP_003).

**Arrows across team bands (withdrawn 2026-10-11 with the by-team view)**

- **REQ_DEP_032** *(withdrawn — decommissioned 2026-10-11: the by-team company view is gone, so there are no arrows between team bands)*
- **REQ_DEP_033** *(withdrawn — decommissioned 2026-10-11: see REQ_DEP_032)*
- **REQ_DEP_034** *(withdrawn — decommissioned 2026-10-11: see REQ_DEP_032)*
- **REQ_DEP_035** *(withdrawn — decommissioned 2026-10-11: see REQ_DEP_032; every team's roadmap is on the company view, so a chevron there never points off screen)*

**Meeting aids on the trace (2026-10-20, decision)**

These help a meeting check that a chain is mapped and moving. They apply to every trace, whichever way it was opened (REQ_DEP_021, REQ_FE_137), and are worked out in the browser from what the trace shows.

- **REQ_DEP_036** — Under the stats line the trace banner shows a health line with five counts over the roadmap items of the chain, its root included: "N at risk", "N overdue" (its end, a milestone's date, is before today and it is not done), "N without owner" (its responsible person is empty or only white space and it is not done), "N milestones without prerequisites" (a milestone that is not done and depends on nothing) and "N tight links" (REQ_DEP_038). These are the attention list's rules (REQ_API_054). A count above zero is a button: it highlights its roadmap items (and, for tight links, those arrows) and fades the rest; a second click, or another count, clears or changes that. A count of zero is shown greyed and does nothing.
- **REQ_DEP_037** — In a trace a small flag sits on the top-right corner of each roadmap item that is not done and has a mapping gap: a flag icon on a milestone without prerequisites and a person icon on a roadmap item without owner, each with a tooltip naming the gap. Like the status badge on the top-left, it may reach above the item but never past its left or right edge, so it never covers a neighbour in its row (REQ_FE_010): only the flags that fit inside the item's width are drawn (a milestone's diamond holds one). Every gap is also named in the item's tooltip, and counted in the health line and the Accountable list either way.
- **REQ_DEP_038** — A link in a trace is tight when its prerequisite is not done and the dependent starts (a milestone: on its date) 14 calendar days or fewer after the prerequisite ends. A tight link's arrow is drawn amber and dashed and carries "N d" (the days between the two dates) next to its arrowhead, and its tooltip reads "N days between <prerequisite> and <dependent>".
- **REQ_DEP_039** — In a trace, when nothing is selected, the side panel shows the "Accountable" list instead of REQ_FE_115's prompt: the roadmap items of the chain grouped by responsible person, shown as typed, and within a group by end date. The groups are sorted by date, soonest first: each group by the earliest end date among its roadmap items (an owner with several counts their most urgent one), the "No owner" group the same way; on the same date the names go A–Z ignoring case, with "No owner" after them. *(Changed 2026-10-21, decision: was A–Z with "No owner" last.)* Each entry shows a diamond (milestone) or a bar (deliverable), the team tag, the name, the status badge, and for an item that is not done its gaps: "Overdue", "No prerequisites" and, for each tight link it is the prerequisite of, "N days before <dependent>". The root is marked. A click on an entry selects that roadmap item; while something is selected in a trace, a "← Accountable" button at the top of the panel clears the selection and brings the list back.
