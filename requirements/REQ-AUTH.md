# Who can do what

- **REQ_AUTH_001** — Reading needs no account. Opening the address shows roadmaps straight away, read-only.
- **REQ_AUTH_002** — Admins log in with a username and password. They can read and edit everything, including adding other admins, editing icon labels and managing teams. Every admin can edit every team's roadmap; there are no per-team permissions.
- **REQ_AUTH_012** — Someone who isn't an admin can't edit icon labels or create, change or delete teams.
- **REQ_AUTH_003** — The password check sits behind one single function, `authenticate(request)`, so single sign-on can replace it later without touching anything else.
- **REQ_AUTH_004** — The first time the app starts with no users, it creates an admin from `bootstrap_admin_user` and `bootstrap_admin_password` in the config. The password is scrambled (argon2id) immediately and never written to a log.

**Logging in**

- **REQ_AUTH_005** — There is no separate login page. Anonymous visitors see a ghost button "Admin login" at the right end of the top bar; it opens a dialog over the current page; on success that same page becomes editable without reloading, keeping the same roadmap, zoom and scroll position.
- **REQ_AUTH_006** — When signed in, the same spot shows a user chip (avatar initials and the user name, tooltip "Signed in as <name> (<role>) — account menu") that opens a menu with "Admin" (for admins) and "Log out".
- **REQ_AUTH_007** — If a change is rejected because the session ran out (401), a banner appears whose button reopens the login dialog. The field keeps what was typed and shows that it was not saved; nothing is resent automatically — after logging in, the user saves it again. *(Simplified 2026-10-11: failed requests are no longer queued and replayed.)*
- **REQ_AUTH_011** — Login attempts are rate-limited, per IP address and per username: after 5 failed attempts that IP or username is locked out for 15 minutes. The lock ends exactly 15 minutes after it was set; the failure count starts over 15 minutes after the first counted failure; a successful login clears that username's count.

**Sessions**

- **REQ_AUTH_008** — Logging in sets a long-lived cookie (HttpOnly, SameSite=Lax, valid for `session_ttl_days`) holding a random 256-bit token; it is `Secure` when the request came over HTTPS, and always when `cookie_secure` is `true` (REQ_DEPLOY_013). The database stores only a fingerprint (SHA-256 hash) of it.
- **REQ_AUTH_009** — Sessions slide: any request in the last half of the session's life extends it and refreshes the cookie, so active people stay logged in.
- **REQ_AUTH_010** — Logging out deletes the session. Disabling a user or resetting their password deletes all of that user's sessions.
- **REQ_AUTH_013** — An admin can create another admin (username and password), reset any admin's password, and disable or re-enable an admin. There is no way to delete a user, so the audit trail always has a real account behind it. Only admins can do any of this.
- **REQ_AUTH_014** — A password must be 8 to 128 characters; this is checked when an admin is created and when a password is reset (`422`, field `password`). Usernames are unique ignoring case (`409 duplicate_name`).
- **REQ_AUTH_015** — The last active admin can't be disabled, and an admin can't disable their own account (`409`, codes `last_admin` / `self_disable`), so the system can never lock everyone out. Re-enabling is always allowed.
- **REQ_AUTH_016** — `GET /api/me` always answers `200`: the logged-in user (`id`, `username`, `role`), or `{"user": null}` for an anonymous visitor, so the app can tell without a failing request.
- **REQ_AUTH_017** — A login with an unknown user, a wrong password or a disabled account all give the same `401 invalid_credentials`, so the answer never reveals which usernames exist. A locked-out IP or username gets `429` (REQ_AUTH_011); the lock keys on the connection's address only and ignores `X-Forwarded-For`.
- **REQ_AUTH_018** — The server stores only a hash of each password (REQ_AUTH_004) and never returns it: no endpoint, log line (REQ_CFG_010) or audit entry ever carries a password, a hash, a session token or a cookie.
- **REQ_AUTH_019** — The username `system` (in any capitals) is reserved for the server's own audit entries (REQ_AUD_020); creating it is refused (`422`, field `username`).
