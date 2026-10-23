# Requirements

The promises the finished app has to keep, written in plain language. They are the reference for what the app does.
Each one has an ID such as `REQ_DAT_004`. Every behaviour
requirement (something the running app does) has at least one test named after its ID, at the cheapest
layer that proves it, so no behaviour can be claimed done without a test that proves it. Requirements
about documents, packaging or process are checked in review instead.

How to read them:

- **Hard rule** marks the hard requirements — never traded away for convenience.
- IDs are permanent. They are never renumbered or reused. A requirement that is dropped stays in the
  file marked *(withdrawn)*; one that changes is edited in place, with the date of the change.
- A **roadmap item** is a deliverable or a milestone. A requirement that covers both says "roadmap
  item"; one that says "deliverable" or "milestone" covers only that one.
- A change to what the app does starts here; the code,
  the tests and `docs/API.md` follow.

| File | What it covers |
|---|---|
| REQ-OVR.md | The big constraints and the technology choices |
| REQ-DAT.md | What is stored and the rules about it |
| REQ-API.md | What the server offers |
| REQ-FE.md | What users see and can do |
| REQ-DEP.md | Dependencies between roadmap items |
| REQ-AUTH.md | Who can do what, logging in |
| REQ-AUD.md | Change history, retention, backups |
| REQ-CFG.md | The config file and logging |
| REQ-IMP.md | The CSV download and the company file (sample and development data) |
| REQ-DEMO.md | The shipped sample data and the development data |
| REQ-TEST.md | How the app is tested |
| REQ-DEPLOY.md | Building, installing and running it |
