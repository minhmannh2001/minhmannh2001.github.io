---
layout: post
title: "I Built a Remote MCP Server with Auto OAuth — Here's How the Auth Magic Works"
date: '2026-06-19 00:00'
excerpt: >-
  For Week 3 of themodernsoftware.dev, I built a remote HTTP MCP server exposing weather tools
  via GitHub OAuth 2.1 + PKCE. The interesting part: Claude's CLI handles the entire auth dance
  automatically — no manual token copying, no browser hacks. Here's how it actually works under the hood.
comments: true
---

# I Built a Remote MCP Server with Auto OAuth — Here's How the Auth Magic Works

This is Week 3 of [The Modern Software Developer](https://themodernsoftware.dev/), a course that takes you through building real software systems the way professionals actually build them. Each week is a focused assignment — not a toy, not a tutorial you copy-paste through, but something you design, spec, implement, and test yourself.

Week 3's assignment: build a **remote HTTP MCP server** with proper authentication.

I built one that exposes weather tools powered by the Open-Meteo API, protected by GitHub OAuth 2.1 with PKCE. But the most interesting part wasn't the weather data — it was implementing the MCP Authorization Spec so that Claude's CLI can authenticate **completely automatically**, with no manual token copying.

This post is about that auth flow: why it's hard, what the spec requires, and how I built it.

---

## What is MCP, and Why Does Remote Auth Matter?

The **Model Context Protocol (MCP)** is Anthropic's open standard for connecting AI assistants to external tools and data sources. Think of it as a plugin system for Claude — you define tools, Claude calls them, and your server executes them.

There are two deployment modes:

- **Local (stdio)**: A process on the same machine as the client, communicating over stdin/stdout. No auth needed — you own the process.
- **Remote (HTTP)**: A server accessible over a network. Now you need auth.

Remote MCP servers are where things get interesting. You can't trust incoming requests — any client on the internet could hit your endpoints. You need to verify that only authorized clients can call your tools.

The naive solution: require users to generate a token, copy it into a config file, and pass it manually. This works, but it's friction-heavy and breaks every time the server restarts (if tokens are in-memory). I know because I started there.

The proper solution: implement the **MCP Authorization Spec**.

---

## The Problem with Manual Tokens

Before implementing the spec, my server required something like this:

```bash
# Generate a token manually
curl -X POST http://localhost:8000/oauth/authorize

# Copy the token, then register with Claude
claude mcp add --transport http weather http://localhost:8000/mcp \
  --header "Authorization: Bearer <paste-token-here>"
```

And because tokens lived only in memory, every server restart meant doing this dance again. It was painful enough that I wrote a `PRD-oauth-spec.md` documenting the problem before touching any code:

> *"Each MCP server restart loses in-memory tokens, forcing developers to manually navigate to `/oauth/authorize`, copy tokens, then re-run `claude mcp remove` and `claude mcp add` repeatedly."*

The fix: make the server speak a protocol that Claude's CLI already understands natively.

---

## The MCP Authorization Spec

The MCP Authorization Spec builds on a stack of well-established RFCs:

- **OAuth 2.1** — the core authorization framework
- **RFC 8414** — OAuth 2.0 Authorization Server Metadata (the `/.well-known/` discovery endpoint)
- **RFC 9728** — OAuth 2.0 Protected Resource Metadata
- **RFC 7591** — Dynamic Client Registration

When a client like Claude's CLI encounters a protected MCP server, it follows this protocol automatically:

1. Send a request → receive `401 Unauthorized` with a `WWW-Authenticate` header
2. Fetch `/.well-known/oauth-protected-resource` to discover the authorization server URL
3. Fetch `/.well-known/oauth-authorization-server` to discover all OAuth endpoints
4. **Dynamically register** as a client via `POST /register`
5. Open a browser → user logs in via GitHub once
6. Receive an authorization code → exchange it for a bearer token
7. Store the token in the macOS Keychain (auto-refresh on expiry)

After step 7, the CLI retries the original request with the bearer token attached. The whole flow takes a few seconds and requires exactly zero manual intervention from the developer.

---

## What I Had to Build

To make this work, I needed four new endpoints beyond the actual MCP tools:

| Endpoint | RFC | Purpose |
|----------|-----|---------|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | Points clients to the authorization server |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Lists all OAuth endpoints (token, auth, register) |
| `POST /register` | RFC 7591 | Dynamic client registration — returns a `client_id` |
| `POST /oauth/token` | OAuth 2.1 | Exchanges authorization codes for bearer tokens |

Plus the existing GitHub OAuth callback at `GET /oauth/callback`, which I had to modify to redirect rather than return JSON directly.

### The Discovery Layer

The `/.well-known/` endpoints are what enable automation. When Claude's CLI hits a 401, it doesn't prompt the user to "go to this URL and copy a token." Instead it reads these discovery documents to learn exactly where to go and what to do.

```python
@app.get("/.well-known/oauth-protected-resource")
async def oauth_protected_resource():
    return {
        "resource": settings.SERVER_URL + "/mcp",
        "authorization_servers": [settings.SERVER_URL],
    }

@app.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server():
    return {
        "issuer": settings.SERVER_URL,
        "authorization_endpoint": settings.SERVER_URL + "/oauth/authorize",
        "token_endpoint": settings.SERVER_URL + "/oauth/token",
        "registration_endpoint": settings.SERVER_URL + "/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
    }
```

### Dynamic Client Registration

Instead of pre-registering clients, any compliant client can register itself on the fly. The server issues a `client_id` (a UUID) and stores the registration in memory:

```python
@app.post("/register")
async def register_client(request: Request):
    body = await request.json()
    client_id = str(uuid.uuid4())
    oauth_clients[client_id] = {
        "client_id": client_id,
        "redirect_uris": body.get("redirect_uris", []),
        "client_name": body.get("client_name", "Unknown Client"),
        "registered_at": time.time(),
    }
    return {"client_id": client_id, "redirect_uris": body["redirect_uris"]}
```

No `client_secret` is issued — this follows the **public client model** from OAuth 2.1, appropriate for native applications like CLIs.

### PKCE: Protecting the Code Exchange

PKCE (Proof Key for Code Exchange) prevents authorization code interception attacks. The flow:

1. Client generates a random `code_verifier`
2. Client computes `code_challenge = BASE64URL(SHA256(code_verifier))`
3. Client sends `code_challenge` with the authorization request
4. After getting the code, client sends `code_verifier` with the token request
5. Server verifies: `BASE64URL(SHA256(code_verifier)) == stored code_challenge`

If an attacker intercepts the authorization code, they can't exchange it for a token — they don't have the `code_verifier`.

```python
@app.post("/oauth/token")
async def token_endpoint(request: Request):
    form = await request.form()
    code = form.get("code")
    code_verifier = form.get("code_verifier")

    if code not in authorization_codes:
        raise HTTPException(status_code=400, detail="Invalid authorization code")

    stored = authorization_codes[code]

    # Verify PKCE
    computed = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode()).digest()
    ).rstrip(b"=").decode()

    if computed != stored["code_challenge"]:
        raise HTTPException(status_code=400, detail="Invalid code_verifier")

    # Single-use: delete after validation
    del authorization_codes[code]

    token = str(uuid.uuid4())
    tokens[token] = {"client_id": stored["client_id"]}
    return {"access_token": token, "token_type": "bearer"}
```

Key details:
- Authorization codes are **single-use** — deleted immediately after exchange
- Codes have a **5-minute TTL** — expired codes return 400
- Tokens have **no expiry** until server restart

### The Callback Redirect

This was a subtle but important detail. When GitHub redirects back to `/oauth/callback`, the server can't return the authorization code as JSON — the client isn't watching that URL. It needs to **redirect** back to the client's `redirect_uri`:

```python
@app.get("/oauth/callback")
async def oauth_callback(code: str, state: str):
    if state not in pending_authorizations:
        raise HTTPException(status_code=400, detail="Invalid state")

    pending = pending_authorizations.pop(state)
    auth_code = str(uuid.uuid4())
    authorization_codes[auth_code] = {
        "client_id": pending["client_id"],
        "code_challenge": pending["code_challenge"],
        "expires_at": time.time() + 300,
    }

    redirect_url = (
        f"{pending['redirect_uri']}?code={auth_code}&state={pending['state']}"
    )
    return RedirectResponse(url=redirect_url)
```

The `state` parameter ties the GitHub callback back to the original client registration, and the redirect delivers the authorization code to the CLI's local callback listener.

---

## The End Result

After implementing the spec, registering the server with Claude requires exactly one command:

```bash
claude mcp add --transport http weather http://localhost:8000/mcp -s project
```

The first time you run this:
1. Claude's CLI hits `/mcp`, gets a 401
2. Discovers endpoints via `/.well-known/`
3. Registers itself dynamically
4. Opens a browser tab for GitHub login
5. You authorize once
6. Token is stored in your keychain

Every subsequent request — including after restarting Claude — uses the stored token automatically. If the server restarts and invalidates the token, Claude's CLI detects the 401 and re-authenticates without any user intervention.

---

## What the Server Actually Does

Beyond auth, the server exposes three weather tools via the Open-Meteo API (free, no API key required):

| Tool | What it does |
|------|-------------|
| `get_current_weather` | Returns current conditions for a lat/lon coordinate |
| `get_forecast` | Returns daily forecast up to 16 days ahead |
| `get_weather_by_city` | Resolves a city name, returns current weather |

These are thin wrappers — the interesting work was always the auth layer.

---

## Lessons

**The MCP Authorization Spec is well-designed.** The combination of RFC 8414 discovery + dynamic client registration + PKCE covers the real threat model for CLI clients without requiring pre-coordination between client and server. Once I understood the full flow, the implementation came together cleanly.

**In-memory state is fine for development.** The spec doesn't require persistent storage, and the CLI handles re-authentication gracefully. For production you'd want a database, but for a course assignment the tradeoff is explicit and documented.

**MCP Inspector is not a spec-compliant client.** It doesn't implement the authorization spec, so you have to supply tokens manually when using it for testing. The spec-compliant path only works end-to-end with Claude's CLI. This caught me off guard early.

**Write the PRD before the code.** I wrote `PRD-oauth-spec.md` documenting the problem, the required endpoints, and the key design decisions before writing any implementation. Having that document made the implementation straightforward — every decision was already made.

---

## Source Code

The full implementation is on GitHub: [minhmannh2001/modern-software-dev-assignments/tree/master/week3](https://github.com/minhmannh2001/modern-software-dev-assignments/tree/master/week3)

This was built as part of [The Modern Software Developer](https://themodernsoftware.dev/) — a course I'd recommend to anyone who wants to build real systems rather than follow along with tutorials.
