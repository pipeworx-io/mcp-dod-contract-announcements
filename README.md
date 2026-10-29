# @pipeworx/dod-contract-announcements

DoD Contract Announcements MCP — every US defense contract award of $7.5M+, published by the Department of War (formerly Department of Defense) on the business day it is signed.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `dod_awards_recent(days=7, service?, min_amount?, limit=25)` — most recent announcements, newest first.
- `dod_awards_search(query?, contractor?, since?, limit=25)` — search by contractor name or description keyword; at least one of `query`/`contractor` required.
- `dod_awards_top(days=30, by='contractor'|'service', limit=20)` — ranks contractors or services by total award value over a window; excludes `shared_award` rows from the ranked total and reports them separately.
- `dod_awards_coverage()` — row count, earliest/latest announcement date, per-service breakdown.

## Auth

None. Keyless.

## Data sources

- Upstream: https://www.war.gov/News/Contracts/ (defense.gov now redirects to war.gov after the department's rename).
- The war.gov contracts feed exposes at most the last 500 business days, so coverage cannot reach further back than that horizon.

## Leading vs. lagging record

This is the **leading** record of a defense contract award — it is announced the day the contract is signed, weeks before the same award appears in FPDS/USAspending. Use this pack for "what was awarded today/this week." Use the [usaspending](/docs/reference/usaspending) pack for the **lagging**, fully structured, cross-referenced historical record (recipient hierarchy, NAICS, place of performance, obligated-vs-outlayed dollars).

## Data caveats

- `shared_award: true` means the row came from a multiple-award paragraph — `amount` is the **combined** program value across all named contractors, not any single contractor's share. `dod_awards_top` excludes these from ranked totals by default and reports them separately.
- `amount_is_ceiling: true` means the source described the figure as a "maximum," "not-to-exceed," or "estimated" value — not a guaranteed obligation.
- `contract_number` is null on roughly 1% of rows.
- `completion_date` is the source's own free text (e.g. "Aug. 27, 2032"), not a normalized date.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "dod-contract-announcements": {
      "url": "https://gateway.pipeworx.io/dod-contract-announcements/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/dod-contract-announcements/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/dod_awards_recent \
  -H 'Content-Type: application/json' \
  -d '{"days":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/dod_awards_recent`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-dod-contract-announcements` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/dod-contract-announcements/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "dod-contract-announcements": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-dod-contract-announcements"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Dod Contract Announcements data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
