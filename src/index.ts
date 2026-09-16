interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * DoD Contract Announcements MCP — the daily press-release feed of every US
 * defense contract award of $7.5M or more, published by the Department of
 * War (the renamed Department of Defense; defense.gov now redirects to
 * war.gov) on the business day the contract is signed. Reads the
 * dod_contract_announcements table (ingested by a scraper of
 * https://www.war.gov/News/Contracts/) via PostgREST.
 *
 * This is the LEADING record of a defense award — it appears weeks before
 * the same award is reflected in FPDS/USAspending, which is the lagging,
 * more-structured record (see the usaspending pack). Use this pack to
 * answer "what did the Pentagon award today/this week" and usaspending for
 * historical, cross-referenced, or fully-structured award data.
 *
 * The pack is stateless (gateway handles auth/rate-limit) and never throws
 * for expected empty results — it shapes LLM-friendly objects and returns
 * { found: false, reason, hint }.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'DoD Contract Announcements');
}

const KNOWN_SERVICES = [
  'ARMY',
  'NAVY',
  'AIR FORCE',
  'DEFENSE LOGISTICS AGENCY',
  'U.S. TRANSPORTATION COMMAND',
  'DEFENSE ADVANCED RESEARCH PROJECTS AGENCY',
  'DEFENSE HEALTH AGENCY',
  'U.S. SPECIAL OPERATIONS COMMAND',
] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'dod_awards_recent',
    description:
      'Most recent US Department of War (formerly Department of Defense) contract award announcements — Pentagon contracts today, this week, or over any recent window, newest first. Every contract of $7.5M or more is announced here on the business day it is signed, which is weeks ahead of the same award appearing in FPDS/USAspending. Filter by military service/agency (ARMY, NAVY, AIR FORCE, DEFENSE LOGISTICS AGENCY, U.S. TRANSPORTATION COMMAND, DEFENSE ADVANCED RESEARCH PROJECTS AGENCY, DEFENSE HEALTH AGENCY, U.S. SPECIAL OPERATIONS COMMAND, and others) and a minimum award amount. Answers "what defense contracts were announced today", "recent DoD/Pentagon contract awards", "who won a defense contract this week".',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: ['number', 'string'], description: 'How many days back from today to include (default 7).' },
        service: { type: 'string', description: 'Restrict to one branch/agency, e.g. "ARMY", "NAVY", "AIR FORCE", "DEFENSE LOGISTICS AGENCY". Matched case-insensitively.' },
        min_amount: { type: ['number', 'string'], description: 'Only awards at or above this dollar amount. Note: on rows where shared_award is true, amount is the combined multi-contractor program value, not one contractor\'s share.' },
        limit: { type: ['number', 'string'], description: 'Max awards to return (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'dod_awards_search',
    description:
      'Search US Department of War (Pentagon) contract award announcements by contractor name or by keyword in the award description — "has Lockheed Martin won a defense contract", "defense contracts for hypersonic missiles", "Pentagon awards mentioning drone swarms". At least one of query or contractor is required. Optionally restrict to awards announced on or after a given date. This is the leading, weeks-ahead-of-USAspending record of an award; combine with the usaspending pack for the fully structured historical record.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text match (case-insensitive) against the award description paragraph, e.g. "hypersonic", "F-35 sustainment", "shipbuilding".' },
        contractor: { type: 'string', description: 'Free-text match (case-insensitive) against the contractor name, e.g. "Lockheed Martin", "Raytheon".' },
        since: { type: 'string', description: 'Only awards announced on or after this date (YYYY-MM-DD).' },
        limit: { type: ['number', 'string'], description: 'Max awards to return (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'dod_awards_top',
    description:
      'Ranks contractors or military services/agencies by total defense contract award value over a recent window — "who are the top defense contractors this month", "which service branch awarded the most this quarter". Ranks by money actually obligated. Two kinds of award are held out of that total and reported alongside it, because folding either one in yields a large, plausible-looking number that means nothing: shared_award rows (a multiple-award paragraph whose amount is the COMBINED program value across every winner, not one company\'s share) and ceiling/not-to-exceed awards (a lifetime maximum on a multi-year contract, not money awarded in this window).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: ['number', 'string'], description: 'Window size in days, ending today (default 30).' },
        by: { type: 'string', description: 'Rank by "contractor" (default) or "service".' },
        limit: { type: ['number', 'string'], description: 'Max ranked entries to return (1-100, default 20).' },
      },
      required: [],
    },
  },
  {
    name: 'dod_awards_coverage',
    description:
      'Reports what DoD/Pentagon contract announcement data is currently available: total row count, the earliest and latest announcement date on file, and a per-service breakdown of counts. Use to gauge coverage before relying on it for a historical range — "how far back does Pipeworx\'s Pentagon contract data go".',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

interface SupabaseConfig {
  url: string;
  key: string;
}

// The Workers runtime sends no default User-Agent. An upstream behind a bot
// filter then answers 403, and that reads as "they closed their API" rather than
// as a missing header — phishtank, chess and devto each went fully dark this way.
const UA = 'pipeworx-mcp-dod-contract-announcements/1.0 (+https://pipeworx.io)';

async function pg<T>(cfg: SupabaseConfig, table: string, query: string): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: 'application/json', 'User-Agent': UA },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`data query ${table}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// Exact row count for a filter, via PostgREST's Content-Range header. Used
// instead of a count() aggregate (aggregate functions are disabled on the
// project). Requests a single row with Prefer: count=exact and parses the
// "0-0/1234" range tail.
async function pgCount(cfg: SupabaseConfig, table: string, query: string): Promise<number> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return 0;
  const range = res.headers.get('content-range') ?? '';
  const total = range.split('/')[1];
  const n = Number(total);
  return Number.isFinite(n) ? n : 0;
}

// PostgREST silently caps any request at 1000 rows regardless of a larger
// `limit=`. Never request more than this for a bulk/aggregate fetch.
const MAX_FETCH = 1000;

interface AwardRow {
  award_key: string;
  announced_on: string;
  article_id: number | null;
  article_url: string | null;
  service: string | null;
  contractor: string;
  contractor_location: string | null;
  amount: number | null;
  amount_is_ceiling: boolean | null;
  contract_number: string | null;
  contract_types: string[] | null;
  contracting_activity: string | null;
  completion_date: string | null;
  shared_award: boolean | null;
  small_business: boolean | null;
  description: string | null;
  first_seen: string | null;
}

const AWARD_SELECT =
  'select=award_key,announced_on,article_url,service,contractor,contractor_location,amount,amount_is_ceiling,contract_number,contract_types,contracting_activity,completion_date,shared_award,small_business,description';

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

function shapeAward(r: AwardRow) {
  return {
    award_key: r.award_key,
    announced_on: r.announced_on,
    service: r.service,
    contractor: r.contractor,
    contractor_location: r.contractor_location,
    amount: r.amount,
    amount_is_ceiling: !!r.amount_is_ceiling,
    shared_award: !!r.shared_award,
    contract_number: r.contract_number,
    contract_types: r.contract_types,
    contracting_activity: r.contracting_activity,
    completion_date: r.completion_date,
    small_business: !!r.small_business,
    description: r.description,
    url: r.article_url,
    ...(r.amount_is_ceiling
      ? { amount_note: 'amount is a ceiling/maximum/not-to-exceed value, not a guaranteed obligation' }
      : {}),
    ...(r.shared_award
      ? { shared_award_note: 'amount is the COMBINED value across all contractors on this multiple-award paragraph, not this contractor\'s individual share' }
      : {}),
  };
}

async function recent(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const days = clampInt(args.days, 1, 500, 7);
  const limit = clampInt(args.limit, 1, 100, 25);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const parts = [`announced_on=gte.${cutoff}`];
  const service = String(args.service ?? '').trim();
  if (service) parts.push(`service=ilike.${encodeURIComponent(service)}`);
  const minAmount = args.min_amount;
  if (minAmount !== undefined && String(minAmount).trim() !== '') {
    parts.push(`amount=gte.${Number(minAmount)}`);
  }
  parts.push(AWARD_SELECT, 'order=announced_on.desc', `limit=${limit}`);

  const rows = await pg<AwardRow[]>(cfg, 'dod_contract_announcements', parts.join('&'));
  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_awards_in_window',
      hint: `No awards announced in the last ${days} day(s)${service ? ` for ${service}` : ''}. Try a larger days value, or use dod_awards_coverage to see the available date range.`,
    };
  }
  return { found: true, count: rows.length, window_days: days, awards: rows.map(shapeAward) };
}

/**
 * Zero-result relaxation for the keyword search.
 *
 * The search is an `ilike *phrase*` against the award description, so it needs
 * the caller's words to appear CONTIGUOUSLY. Measured 2026-09-10:
 *
 *   query "155mm ammunition" -> found:false, no_match
 *   query "ammunition"       -> found:true, 11 Army awards, e.g. W911S2-26-C-A004,
 *                               APEX Engineering PLLC, $16,220,928
 *
 * The data was there the whole time. The caller was more specific than the
 * announcement text, which describes the same thing in different words — and
 * the empty result then travelled a long way: it was written up as "no source
 * for 155mm-ammunition CONTRACT AWARDS", reached Bruce's Router Quality page as
 * a coverage gap, and he ruled we did not carry defense contract awards. A
 * silent zero became a false fact about our own catalog (fleet #1825).
 *
 * The old hint told the CALLER to "try a broader keyword". That is advice a
 * human might act on and an agent almost never does — it reads the empty
 * result as an answer and moves on. So we take our own advice here.
 *
 * The ladder drops the tokens that make a phrase over-specific — calibres, part
 * numbers, anything carrying a digit — then falls back to the single longest
 * remaining word. Both steps are DISCLOSED in the response, structurally, under
 * `relaxed`: a broadened search that does not say it broadened is a different
 * answer to the question that was asked, which is worse than the empty result
 * it replaced.
 */
function relaxations(query: string): { term: string; dropped: string[] }[] {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];
  const out: { term: string; dropped: string[] }[] = [];
  // 1. Drop calibre/part-number-ish tokens: "155mm", "M795", "9x19".
  const kept = tokens.filter((t) => !/\d/.test(t));
  const dropped = tokens.filter((t) => /\d/.test(t));
  if (kept.length && dropped.length) out.push({ term: kept.join(' '), dropped });
  // 2. Fall back to the LAST word, not the longest. English noun phrases put
  //    the head noun last, so "155mm ammunition" -> "ammunition" and "mortar
  //    fuze" -> "fuze", which is the thing being bought. Longest-word picked
  //    the adjective often enough to matter: "Lockheed hypersonic missiles"
  //    relaxed to "hypersonic" and quietly dropped the company.
  //
  //    It can still broaden away a contractor named inside `query` rather than
  //    in `contractor` — "Lockheed hypersonic missiles" becomes "missiles".
  //    That is disclosed rather than silent, and the honest fix for the caller
  //    is the `contractor` argument, which is never relaxed.
  const base = kept.length ? kept : tokens;
  const head = base[base.length - 1];
  if (head && !out.some((r) => r.term === head)) {
    out.push({ term: head, dropped: tokens.filter((t) => t !== head) });
  }
  return out;
}

async function search(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  const contractor = String(args.contractor ?? '').trim();
  if (!query && !contractor) {
    return {
      found: false,
      reason: 'missing_args',
      hint: 'Provide at least one of query (matches the award description) or contractor (matches the contractor name).',
    };
  }
  const limit = clampInt(args.limit, 1, 100, 25);
  const parts: string[] = [];
  if (query) parts.push(`description=ilike.*${encodeURIComponent(query)}*`);
  if (contractor) parts.push(`contractor=ilike.*${encodeURIComponent(contractor)}*`);
  const since = String(args.since ?? '').trim();
  if (since) parts.push(`announced_on=gte.${encodeURIComponent(since)}`);
  parts.push(AWARD_SELECT, 'order=announced_on.desc', `limit=${limit}`);

  const runQuery = async (q: string) => {
    const p: string[] = [];
    if (q) p.push(`description=ilike.*${encodeURIComponent(q)}*`);
    if (contractor) p.push(`contractor=ilike.*${encodeURIComponent(contractor)}*`);
    if (since) p.push(`announced_on=gte.${encodeURIComponent(since)}`);
    p.push(AWARD_SELECT, 'order=announced_on.desc', `limit=${limit}`);
    return pg<AwardRow[]>(cfg, 'dod_contract_announcements', p.join('&'));
  };

  let rows = await pg<AwardRow[]>(cfg, 'dod_contract_announcements', parts.join('&'));
  const tried: string[] = [query];
  // Only relax a QUERY. A contractor name is an identity, not a description:
  // broadening "Lockheed Martin" to "Lockheed" is defensible but broadening it
  // to "Martin" returns a different company, and this tool's whole value is
  // that a named contractor means that contractor.
  if (rows.length === 0 && query) {
    for (const step of relaxations(query)) {
      tried.push(step.term);
      const retry = await runQuery(step.term);
      if (retry.length) {
        return {
          found: true,
          count: retry.length,
          awards: retry.map(shapeAward),
          // Structured, not prose — a synthesising model reads past prose and
          // will report these as matches for the original phrase.
          relaxed: {
            requested: query,
            searched: step.term,
            dropped: step.dropped,
            why: `No award description contains the exact phrase "${query}". These match "${step.term}" instead, so read them as awards in that category rather than as exact matches for every word you asked for.`,
          },
        };
      }
    }
  }
  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_match',
      // Say what was actually attempted. "No match" for one phrase and "no
      // match after broadening twice" are different facts about the catalog,
      // and only the second is evidence of a real gap.
      tried,
      hint: `No announcements matched${tried.length > 1 ? ` — tried ${tried.map((t) => `"${t}"`).join(', ')}` : ''}. Drop the since filter, try a contractor name, or check usaspending for the fully structured historical award record.`,
    };
  }
  return { found: true, count: rows.length, awards: rows.map(shapeAward) };
}

async function top(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const days = clampInt(args.days, 1, 500, 30);
  const limit = clampInt(args.limit, 1, 100, 20);
  const by = String(args.by ?? 'contractor').trim().toLowerCase() === 'service' ? 'service' : 'contractor';
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const rows = await pg<Array<{ service: string | null; contractor: string; amount: number | null; shared_award: boolean | null; amount_is_ceiling: boolean | null }>>(
    cfg,
    'dod_contract_announcements',
    [`announced_on=gte.${cutoff}`, 'select=service,contractor,amount,shared_award,amount_is_ceiling', 'order=announced_on.desc', `limit=${MAX_FETCH}`].join('&'),
  );

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_awards_in_window',
      hint: `No awards announced in the last ${days} day(s). Try a larger days value.`,
    };
  }

  const ranked = rows.filter((r) => !r.shared_award && Number.isFinite(Number(r.amount)));
  const excluded = rows.filter((r) => r.shared_award);

  // Obligations and CEILINGS are tracked apart, and the ranking is by
  // obligation. A ceiling is the most a contract could ever be worth over its
  // whole life, so adding one to actual awards produces a number that means
  // nothing: a single $131.23B 20-year F-15 IDIQ ceiling put the Air Force at
  // $133B for a month in which it actually obligated ~$1.9B, and the
  // leaderboard looked entirely plausible. Same conflation the row-level
  // amount_is_ceiling flag prevents, one level up — this is where it misleads.
  const totals = new Map<string, { obligated: number; ceiling: number; count: number; ceilingCount: number }>();
  for (const r of ranked) {
    const key = (by === 'service' ? r.service : r.contractor) ?? 'UNKNOWN';
    const entry = totals.get(key) ?? { obligated: 0, ceiling: 0, count: 0, ceilingCount: 0 };
    if (r.amount_is_ceiling) {
      entry.ceiling += Number(r.amount);
      entry.ceilingCount += 1;
    } else {
      entry.obligated += Number(r.amount);
    }
    entry.count += 1;
    totals.set(key, entry);
  }

  const excludedTotal = excluded.reduce((s, r) => s + (Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0), 0);

  const leaderboard = [...totals.entries()]
    .map(([name, v]) => ({
      [by]: name,
      total_obligated: v.obligated,
      award_count: v.count,
      ...(v.ceilingCount > 0
        ? {
            ceiling_value: v.ceiling,
            ceiling_award_count: v.ceilingCount,
            ceiling_note:
              'Ceiling/not-to-exceed awards are reported separately and are NOT in total_obligated — a ceiling is a lifetime maximum, not money awarded in this window.',
          }
        : {}),
    }))
    .sort((a, b) => (b.total_obligated as number) - (a.total_obligated as number))
    .slice(0, limit);

  return {
    found: true,
    window_days: days,
    ranked_by: by,
    rows_fetched: rows.length,
    fetch_capped_at: MAX_FETCH,
    note:
      rows.length === MAX_FETCH
        ? `Aggregate is based on the most recent ${MAX_FETCH} announcements in this window, which may not be the full window if activity is high — narrow days for a complete total.`
        : `Aggregate is based on all ${rows.length} announcements in this window.`,
    shared_awards_excluded: {
      count: excluded.length,
      combined_program_value: excludedTotal,
      note: 'These rows carry shared_award=true — amount is a combined multi-contractor program value, so they are excluded from the ranked totals above rather than double-counted. See dod_awards_search/dod_awards_recent for the individual rows.',
    },
    ranking_basis: 'total_obligated — ceiling/not-to-exceed awards are listed per row but excluded from the ranked total',
    leaderboard,
  };
}

async function coverage(cfg: SupabaseConfig) {
  const total = await pgCount(cfg, 'dod_contract_announcements', 'select=award_key');
  if (total === 0) {
    return {
      found: false,
      reason: 'no_data',
      hint: 'No DoD contract announcements are loaded yet.',
    };
  }
  const [earliest] = await pg<Array<{ announced_on: string }>>(
    cfg,
    'dod_contract_announcements',
    'select=announced_on&order=announced_on.asc&limit=1',
  );
  const [latest] = await pg<Array<{ announced_on: string }>>(
    cfg,
    'dod_contract_announcements',
    'select=announced_on&order=announced_on.desc&limit=1',
  );

  const perService = await Promise.all(
    KNOWN_SERVICES.map(async (service) => ({
      service,
      count: await pgCount(cfg, 'dod_contract_announcements', `service=ilike.${encodeURIComponent(service)}`),
    })),
  );
  const knownTotal = perService.reduce((s, c) => s + c.count, 0);

  return {
    found: true,
    total_rows: total,
    earliest_announced_on: earliest?.announced_on ?? null,
    latest_announced_on: latest?.announced_on ?? null,
    services: [...perService, { service: 'OTHER / UNLISTED', count: Math.max(total - knownTotal, 0) }],
    note:
      'Coverage begins at the RSS backfill horizon — war.gov\'s contracts feed exposes at most the last 500 business days, so history does not extend earlier than that regardless of when ingest started. This is the LEADING record of a defense award (announced the day it is signed); usaspending is the lagging, fully structured record for historical/cross-referenced analysis.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = (args._supabaseUrl as string | undefined)?.trim();
  const supabaseKey = (args._supabaseKey as string | undefined)?.trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('dod-contract-announcements is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  }
  const cfg: SupabaseConfig = { url: supabaseUrl, key: supabaseKey };

  switch (name) {
    case 'dod_awards_recent':
      return recent(cfg, args);
    case 'dod_awards_search':
      return search(cfg, args);
    case 'dod_awards_top':
      return top(cfg, args);
    case 'dod_awards_coverage':
      return coverage(cfg);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
