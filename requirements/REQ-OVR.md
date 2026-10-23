# Overall constraints

The app has to be easy for a company's IT to host and hard to break by accident.

**Where it runs**

- **REQ_OVR_001** — It runs on a plain Linux or Windows server, with no Kubernetes.
- **REQ_OVR_002** — It needs no separate database, cache or message broker.
- **REQ_OVR_003** — Installing it means copying one program and one config file and registering a service. Nothing like Python, Node or Java has to be installed on the server.
- **REQ_OVR_004** — A developer can run it locally without Docker.

**Technology**

- **REQ_OVR_005** — The server is written in Go 1.23 or newer, using the standard web library and the `chi` router. The AI connection (REQ_API_056) uses the official MCP Go SDK, `github.com/modelcontextprotocol/go-sdk`. *(Changed 2026-10-19: the SDK added, decision.)*
- **REQ_OVR_006** — The database is SQLite through the `modernc.org/sqlite` driver, never a driver that needs a C compiler. (This is what lets us build the Windows program from Linux.)
- **REQ_OVR_007** — The web app is React 19 with TypeScript, Vite and Tailwind 4, plus `lucide-react`, TipTap, `axios` and `driver.js` (the guided tour, REQ_FE_128). *(Changed 2026-10-11: `idb-keyval` was never used and is gone. Changed 2026-10-17: `driver.js` added, decision.)*
- **REQ_OVR_008** — The finished web app is built into the Go program and served by it. Any address the server doesn't know shows the app's main page.
- **REQ_OVR_009** — No drag-and-drop library is used; all dragging is written with the browser's own pointer events.

**Naming and safety**

- **REQ_OVR_010** — The rows are called workstreams: "lane", "swimlane" and "track" are never used as a name for them in code, database, screens or docs (ordinary English uses of "track", e.g. "keeps track of", are fine). The bars are deliverables, never "epics" (naming a Jira epic as a link target is fine).
- **REQ_OVR_011** — Nothing ever deletes or overwrites someone's roadmap data unless a person explicitly confirms it. The only automatic deletions are the old audit-log entries, the oldest daily backups and expired login sessions.
- **REQ_OVR_012** — Every rule the screens enforce (dates, cycles, the three-year limit, permissions) is enforced again by the server, so nothing can get around it by talking to the API directly.
- **REQ_OVR_013** — The server limits how long it waits for a request's headers and body and for writing its answer, so a slow client can't hold a connection open.
- **REQ_OVR_014** — *(2026-10-22, decision)* The application is called **Overlens**. The browser tab title, the documentation, the packaging descriptions and the name the AI connection gives itself (`overlens`, REQ_API_056) use it. The technical names stay as they are, so existing installations keep working: the program `roadmap` / `roadmap.exe`, the config file `roadmap.conf`, the `ROADMAP_*` environment variables, the database and backup file names, the `roadmap` / `Roadmap` service.
