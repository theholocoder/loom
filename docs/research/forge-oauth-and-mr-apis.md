# Forge OAuth and Merge request APIs (GitHub, GitLab)

Research for issue #4. Question: how does the Electron **Client** authenticate users against a **Forge** (GitHub, GitLab.com, self-hosted GitLab), how can the **Server** trust that identity, which scopes/APIs are needed to read issues and open **Merge requests**, and where should forge tokens live?

Sources are first-party docs (docs.github.com, docs.gitlab.com, electronjs.org), read 2026-10-26. Claims marked *(inference)* are my conclusions, not statements from the docs.

## TL;DR

- **Flow:** use the **authorization code flow with PKCE (S256) and a loopback redirect** (`http://127.0.0.1:<port>/callback`) in the system browser, on both forges. Keep the **device flow** only as a fallback: GitHub advises against enabling it outside constrained environments because it is phishable.
- **Trust:** make the Loom **Server** the confidential OAuth client. The Client sends `code` + `code_verifier` to the Server, the Server exchanges them (it holds the `client_secret`), calls the forge's "who am I" endpoint, keys the Loom user on the forge's **immutable numeric user id**, and issues its own Loom session. This also solves GitHub's requirement that the web flow's token exchange and refresh include `client_secret`, which a desktop app cannot keep secret.
- **GitHub: GitHub App over OAuth App.** It has fine-grained permissions (Issues: read, Pull requests: write, Contents: write, Metadata: read) instead of the all-powerful `repo` scope, user tokens expire (8 h, refresh 6 months), and it avoids per-org "OAuth app access restrictions" approval. The cost is that it must be **installed** on the org/repos, and user tokens are limited to the intersection of user and installation access.
- **GitLab:** register one OAuth application per GitLab instance. It can be instance-wide (admin, can be marked *trusted*), group-owned or user-owned. Scopes are `api` (required for creating MRs; `read_api` is read-only), plus `read_user` (or `openid`), plus `write_repository` if the agent pushes over HTTPS with this token. Access tokens last 2 h by default, refresh tokens rotate, and the device grant is GA since GitLab 17.9.
- **Token location:** each Team's self-hosted Server holds the app secrets and the refresh tokens. The Client holds only short-lived access tokens, encrypted with Electron `safeStorage`, refreshing through the Server. Rationale: git push and forge calls happen on the Client (ADR 0001), but refresh needs the secret, and server-held refresh tokens allow central revocation. On Linux, `safeStorage` can silently fall back to a hard-coded key (`basic_text`).

## 1. OAuth flows for a desktop app

### GitHub

GitHub supports three relevant mechanisms (OAuth Apps and GitHub Apps share them):

| Flow | Desktop suitability | Secret needed? |
|---|---|---|
| Web flow + **PKCE** + **loopback** redirect | Recommended for native apps | `client_secret` **required** for code exchange and refresh, even with PKCE |
| **Device flow** | Works, but phishable | No secret: only `client_id` + `device_code` |
| Web flow without PKCE | Not for public clients | Yes |

- **PKCE:** supported via `code_challenge` / `code_challenge_method`. "The `plain` code challenge method is not supported", so S256 only. [authorizing-oauth-apps], [gh-app-user-token]
- **Loopback:** for OAuth Apps, "The `redirect_uri` does not need to match the port specified in the callback URL for the app": register `http://127.0.0.1/callback`, then use any ephemeral port at runtime. GitHub recommends `127.0.0.1`/`::1` over `localhost`. [authorizing-oauth-apps] The GitHub App user-token page does not mention the loopback port relaxation and says `redirect_uri` "must match one of the URLs you provided as a Callback URL" [gh-app-user-token]. *(inference)* So for a GitHub App, plan on a fixed port, or register a few callback URLs, until this is verified.
- **Client secret:** the web-flow code exchange takes `client_id`, `client_secret` and `code`. Refreshing also requires `client_secret`, "unless the token came from the device flow". [authorizing-oauth-apps] GitHub's best-practice pages say native/public clients "cannot secure your client secret" and must ship it in code, so they should use PKCE. [gh-app-best-practices], [oauth-app-best-practices] *(inference)* Shipping the secret in the Electron bundle is effectively public. Doing the exchange on the Loom Server avoids that.
- **Device flow:** it must be enabled in the app settings, otherwise you get `device_flow_disabled`. The verification URI is `https://github.com/login/device`, codes expire after 900 s, you respect `interval` and add 5 s on `slow_down`, and user code submission is capped at 50/h per app. [authorizing-oauth-apps] GitHub advises against enabling it unless the app runs in a "constrained environment (CLIs, IoT devices, or headless systems)" because it has no redirect URI and is abused for phishing. [oauth-app-best-practices]

### GitLab (GitLab.com and self-managed)

- **Flows:** authorization code with PKCE ("Most secure. Without PKCE, you'd have to include client secrets on mobile clients"), plain authorization code, and the device authorization grant. The device grant was introduced in 17.2 behind `oauth2_device_grant_flow`, enabled by default in 17.3, and GA in **17.9**. [gitlab-oauth2]
- **Public client:** clear the application's **Confidential** checkbox. A confidential app rejects secret-less (PKCE) clients with `invalid_client`, as documented for `glab`. [glab-auth], [gitlab-applications-api] PKCE then needs no secret at all. [gitlab-oauth2]
- **Redirect URI:** the `redirect_uri` in the token request must match the authorization request. "For production, use HTTPS for your redirect_uri. For development, GitLab allows insecure HTTP redirect URIs." [gitlab-oauth2] The docs don't say whether the loopback port can vary. GitLab's own CLI registers a fixed `http://localhost:7171/auth/redirect`. [glab-auth] *(inference)* Use a fixed port for GitLab.
- **Self-managed:** an OAuth application must exist **on each instance**, as user-owned, group-owned, or instance-wide (Admin area; "mark it as trusted" to skip the consent screen). [gitlab-oauth-provider], [glab-auth] *(inference)* Because a Loom Server hosts one Team, the Team admin configures the forge base URL + client id (+ secret) on the Server once, and Clients fetch that config from the Server.
- **Tokens:** "By default, access tokens expire after two hours (7200 seconds)". The lifetime is configurable on self-managed. Refreshing "Invalidates the existing access_token and refresh_token" (rotation). [gitlab-oauth-provider], [gitlab-oauth2]

## 2. GitHub: OAuth App vs GitHub App

| | OAuth App | GitHub App |
|---|---|---|
| Permissions | Broad scopes. Private-repo issues + PRs need **`repo`** (full read/write to all private repos the user can reach) [oauth-scopes] | Fine-grained: e.g. Issues read, Pull requests write [gh-app-permissions] |
| Repo reach | Everything the user can access | Only repos where the app is **installed** and the user has access (intersection) [deciding-gh-app], [gh-app-user-token] |
| Token expiry | Non-expiring unless opt-in to expiring tokens (8 h / refresh 6 mo) [authorizing-oauth-apps] | User tokens expire after 8 h by default, refresh token after 6 months [gh-app-user-token] |
| Org policy | New orgs have **OAuth app access restrictions** on by default. Unapproved apps get no API access to private org resources until an owner approves [oauth-restrictions] | Org owner installs the app and picks repos [deciding-gh-app] |
| Attribution | Acts as the user | Shown as "performed by the app on behalf of the user" [deciding-gh-app] |
| Rate limit | 5,000 req/h per user (shared across the user's tokens) [rest-rate-limits] | Same 5,000/h for user tokens (15,000 on GHEC). Installation tokens scale up to 12,500/h [rest-rate-limits] |

*(inference)* **Recommendation: GitHub App.** Each Team registers its own app (the secret lives on its Server) and installs it on the org. Permissions to request:

- **Metadata: read** (mandatory for every GitHub App)
- **Issues: read**: `GET /repos/{owner}/{repo}/issues` [gh-app-permissions]
- **Pull requests: write**: `POST /repos/{owner}/{repo}/pulls`; `GET .../pulls` needs read [gh-app-permissions]
- **Contents: write**: to push the Session branch over HTTPS with the user token *(inference: creating a PR itself is listed only under Pull requests, but "you must have write access to the head or the source branch" [rest-pulls])*
- **Workflows: write**: only if agents may edit `.github/workflows/*` (OAuth equivalent: `workflow` scope [oauth-scopes])

If an OAuth App is chosen instead, the scopes are `repo` (+ `read:user`, optionally `workflow`). Check the granted scopes at runtime through the `X-OAuth-Scopes` response header, since users can edit them. [oauth-scopes]

## 3. GitLab scopes and APIs

| Need | Scope |
|---|---|
| Identify user | `read_user` (or `openid` + `profile`/`email` for OIDC) |
| Read issues / MRs | `read_api` suffices |
| **Create MR** | **`api`** ("Full read/write access to the API"); `read_api` is read-only |
| Git push over HTTPS with the OAuth token | `write_repository` |

Scope definitions: [gitlab-oauth-provider]. `glab` requests `openid profile read_user write_repository api`, a good reference set. [glab-auth]

Endpoints: `GET /projects/:id/issues`, `POST /projects/:id/merge_requests` (with `source_branch`, `target_branch`, `title`), `GET /api/v4/user`. [gitlab-mr-api]

## 4. Making the identity trustworthy to the Loom Server

The Client must never just tell the Server "I am user X". Options, best first:

1. **Server-side code exchange (recommended).**
   1. Client generates PKCE `code_verifier`/`state` and opens the system browser to the forge authorize URL with a loopback `redirect_uri`.
   2. The loopback listener in the Electron main process receives `code` and checks `state`.
   3. Client POSTs `{code, code_verifier, redirect_uri}` to the Loom Server.
   4. Server exchanges it with `client_secret` and gets the forge access + refresh token.
   5. Server calls `GET https://api.github.com/user` or `GET <gitlab>/api/v4/user` with the token.
   6. Server maps the forge's **numeric `id`** to a Loom user. GitHub: "Never use identifiers that can change over time, including user handles, organization slugs, or email addresses." [oauth-app-best-practices], [gh-app-best-practices]
   7. Server issues a Loom session token and returns the access token to the Client.

   Because only the Server holds the secret, a code minted for another app cannot be redeemed. That gives audience binding for free.
2. **Client does the exchange (device flow or GitLab PKCE), then sends the access token to the Server for verification.** The Server must check **audience**, not just validity. Otherwise any token for that user (e.g. from another app) would be accepted.
   - GitHub: `POST /applications/{client_id}/token` with Basic auth `client_id:client_secret` returns `user`, `scopes`, `expires_at`, and 404 if invalid or not issued to this app. [gh-check-token]
   - GitLab: `GET /oauth/token/info` returns `resource_owner_id`, `scope`, `expires_in` and `application` (check that `application.uid` is Loom's client id). [gitlab-oauth2]
3. **GitLab OIDC `id_token`** (scope `openid`): the Server could verify the JWT signature against the instance's JWKS. *(inference; GitHub has no OIDC for user sign-in, so this would not be uniform.)*

**Membership/authorization:** "You must routinely check that their memberships, access, and their current SSO status" still allow access; use `GET /user/installations` for GitHub Apps. [gh-app-best-practices] *(inference)* The Server should restrict sign-in to members of the Team's configured org/group and re-check on refresh.

## 5. Where forge tokens live

| | Client only (safeStorage) | Server only | **Split (recommended)** |
|---|---|---|---|
| Git push / forge calls from Client (ADR 0001) | Direct | Server must proxy every call, or hand out tokens anyway | Client holds short-lived access token |
| Refresh needs `client_secret` (GitHub web flow) | Impossible without shipping the secret | Fine | Client asks Server to refresh |
| Central revocation when someone leaves the Team | No | Yes | Yes: drop the refresh token; access token dies within 8 h / 2 h |
| Blast radius of a Server breach | None | All users' tokens | Refresh tokens for all users (encrypt at rest; GitHub suggests storing refresh tokens separately from access tokens [oauth-app-best-practices]) |
| Server compromise vs laptop compromise | Laptop only | Server only | Both, but each piece is limited |

**Electron `safeStorage` caveats** [electron-safestorage]:
- macOS Keychain protects data from other users and other apps.
- Windows DPAPI protects from other users "but not from other apps running in the same userspace".
- Linux depends on a secret store (gnome-libsecret / kwallet). If none is available, "items stored in using the safeStorage API will be unprotected as they are encrypted via hardcoded plaintext password". Detect this with `getSelectedStorageBackend() === 'basic_text'` and warn or refuse.
- The sync API (`isEncryptionAvailable`, `encryptString`) is deprecated in favour of `encryptStringAsync`/`decryptStringAsync`, slated for removal in Electron 46. Call it only after `app` `ready`.

## 6. Rate limits and expiry

**GitHub** [rest-rate-limits]:
- 5,000 req/h per authenticated user, shared across all that user's tokens and apps (15,000 for GHEC-owned apps). Unauthenticated: 60/h.
- Secondary limits:
  - ≤100 concurrent requests
  - 900 points/min REST (GET = 1, writes = 5)
  - ~80 content-creating requests/min and 500/h
  - 2,000 OAuth token requests/h per app
- Token lifetimes:
  - GitHub App user token: 8 h, refresh token 6 months, rotated on use [gh-app-user-token]
  - Installation token: 1 h [gh-app-best-practices]
  - OAuth App tokens never expire unless expiring tokens are opted in [deciding-gh-app], [authorizing-oauth-apps]

**GitLab.com** [gitlab-rate-limits]:
- Authenticated API: 2,000 req/min per user currently.
- Proposed per-plan limits, not yet in effect: Free 5,000/h with 100/min burst, up to Ultimate 25,000/h.
- Issue creation: 200/min. Notes on issues/MRs: 60/min.
- Unauthenticated: 500/min/IP.
- Self-managed limits are admin-configured.

**Token lifetime:** GitLab access tokens last 2 h by default; refresh rotates both tokens. [gitlab-oauth-provider], [gitlab-oauth2]

*(inference)* At Loom's per-user scale (a few Sessions polling issue/MR status), the limits are not a concern if the Client uses conditional requests/ETags and avoids tight polling. Webhooks are a later option, but they would need the Server to be reachable from the forge.

## Open questions for follow-up tickets

- Verify whether GitHub App callbacks accept a variable loopback port like OAuth Apps do, and whether GitLab (Doorkeeper) does. Otherwise, use a fixed port with a fallback list.
- Confirm whether GitLab's `api` scope alone permits git-over-HTTPS push, or `write_repository` is required (glab requests both).
- Decide whether the Server should also proxy forge API calls (e.g. for Server-side Project metadata), which would change the token-placement trade-off.

## Sources

- [authorizing-oauth-apps]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- [gh-app-user-token]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- [deciding-gh-app]: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app
- [gh-app-best-practices]: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
- [oauth-app-best-practices]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app
- [oauth-scopes]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- [oauth-restrictions]: https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions
- [gh-app-permissions]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- [gh-check-token]: https://docs.github.com/en/rest/apps/oauth-applications
- [rest-pulls]: https://docs.github.com/en/rest/pulls/pulls
- [rest-rate-limits]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- [gitlab-oauth2]: https://docs.gitlab.com/api/oauth2/
- [gitlab-oauth-provider]: https://docs.gitlab.com/integration/oauth_provider/
- [gitlab-applications-api]: https://docs.gitlab.com/api/applications/
- [glab-auth]: https://docs.gitlab.com/cli/authentication/
- [gitlab-mr-api]: https://docs.gitlab.com/api/merge_requests/
- [gitlab-rate-limits]: https://docs.gitlab.com/user/gitlab_com/rate_limits/
- [electron-safestorage]: https://www.electronjs.org/docs/latest/api/safe-storage
