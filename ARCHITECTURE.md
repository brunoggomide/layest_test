# Architecture

## 1. Data model

```
tenants --< runs --< feedback_events --< knowledge_evidence >-- knowledge_items
              |                                                     |
              +---------------< run_knowledge_trace >---------------+
```

| Table | Key columns | Notes |
|---|---|---|
| `tenants` | `id`, `name` | Seeded with fixed ids. |
| `runs` | `id`, `tenant_id`, `invoice_ref`, `idempotency_key`, `input`, `output`, `status`, `created_at` | `input = {invoice}`; `output` is the whole run result (`suggestion`, `anchors`, applied / retrieved / shadowed refs), stored as is so a replay returns exactly what the first call did. `UNIQUE (tenant_id, idempotency_key)`. `status` starts as `pending_review` and is set by the feedback. |
| `feedback_events` | `id`, `run_id` (unique), `tenant_id`, `kind`, `diff`, `error`, `reviewer_id`, `created_at` | One decision per run. `diff = {field: {before, after}}` for adjustments; `error` for failures. |
| `knowledge_items` | `id`, `scope`, `tenant_id`, `type`, `anchor`, `subject_key`, `rule`, `rule_text`, `supporting_context`, `status`, `confidence`, `evidence_count`, `contested_count`, `distinct_tenant_count`, `source_event_id`, `source_run_id`, `version`, `supersedes_id`, `created_at`, `reviewed_at`, `reviewed_by`, `activated_at`, `valid_until` | `CHECK ((scope = 'global') = (tenant_id IS NULL))`. |
| `knowledge_evidence` | `(knowledge_item_id, feedback_event_id)`, `tenant_id` | Every feedback event that supports an item. A global item links the events of each source tenant. |
| `run_knowledge_trace` | `(run_id, knowledge_item_id, role)`, `version` | `role` is `retrieved` or `applied`; the version is pinned. |

**One active truth per slot**, enforced for every role by a partial unique index:

```sql
CREATE UNIQUE INDEX one_active_per_key
  ON knowledge_items (scope, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), subject_key)
  WHERE status = 'active';
```

Global rows have `tenant_id = NULL`; the sentinel uuid gives them one namespace.

## 2. Subjects: anchors and slots

An item is about one **anchor** (used for retrieval) and fills one **slot** (`subject_key`, of
which at most one item is active per scope and tenant). `src/internal/knowledge/keys.ts` is the
only place that builds them.

| Type | Anchor | Slot (`subject_key`) | Rule | Global? |
|---|---|---|---|---|
| `account_mapping` | `vendor=<v>` | `vendor=<v>\|account` | `{account}` | never |
| `account_veto` | `vendor=<v>` | `vendor=<v>\|account` | `{forbidden_accounts: [..]}` | never |
| `booking_rule` | `vendor=<v>` | `vendor=<v>\|booking:<field>` | `{field, value}` | never |
| `field_mapping` | `vendor=<v>` | `vendor=<v>\|field_mapping:<to>` | `{from, to}` | never |
| `naming_convention` | `tenant` | `tenant\|naming:<field>` | `{field, template}` | never |
| `extraction_failure_pattern` | `doc_pattern=<sha1>` | `doc_pattern=<sha1>\|failure` | `{doc_structure, error_signature, missing_field?, recovery_strategy?}` | yes |

- Vendor normalization: `Rossi S.p.A.` -> `rossi` (case, accents, punctuation and a trailing legal
  form are dropped). Field normalization: `Cost Center` -> `cost_center`.
- The document pattern is a SHA-1 of the sorted JSON of a **closed list** of structural features
  (`layout, header, columns, doc_type, pages, language, currency_column, has_line_items`), string
  values lower-cased. Unknown features never enter the hash.
- Structural values (error codes, missing fields, recovery strategies, document types) are
  **lowercase identifiers** (`[a-z0-9][a-z0-9_.:-]*`). Anything else is not structure and is dropped.
- A mapping and a veto share the `account` slot on purpose: one truth about the account of a vendor.
  A confirmed mapping is strictly more information than a veto, so activating one supersedes the other,
  explicitly, through conflict resolution.

Every type has a rule schema (`src/internal/knowledge/rules.ts`). The extractor's output is checked
against it in tests, and a reviewer's edit is refused with the issues when it does not fit.

## 3. Lifecycle

```
                 accept                   (no active item on the slot, or only own predecessor)
 candidate ---------------> accepted --------------------------------------------------> active
     |                         |  ^                                                       |  |
     | reject                  |  | accept (another item holds the slot)                  |  | disable
     v                         |  +-- held: {status: accepted, pending_conflict_with}     |  v
 rejected <--------------------+ resolve-conflict {winner: existing}                      | disabled
                                                                                          |
                           resolve-conflict {winner: new} ------------------------------->|
                                                                                          v
                              a newer version or a conflict winner activates --> superseded
```

| Endpoint | From | To | Refused (409 `invalid_transition`) |
|---|---|---|---|
| `POST /knowledge/:id/accept` `{reviewer_id, valid_until?}` | candidate, accepted | active, or accepted + `pending_conflict_with` | active, rejected, disabled, superseded |
| `POST /knowledge/:id/resolve-conflict` `{reviewer_id, winner}` | accepted | active (`new`; the loser becomes superseded) or rejected (`existing`) | any other status |
| `POST /knowledge/:id/edit` `{reviewer_id, rule, rule_text}` | candidate, accepted, active | **new row**, `version + 1`, `supersedes_id` = old id, status candidate; the old row is untouched | rejected, disabled, superseded; 400 when the rule does not fit the type |
| `POST /knowledge/:id/reject` | candidate, accepted | rejected | active, disabled, superseded, rejected |
| `POST /knowledge/:id/disable` | candidate, accepted, active | disabled (soft delete; frees the slot) | rejected, superseded |
| `GET /knowledge/:id/history` | | the whole `supersedes_id` chain, both directions, oldest version first | |

Reviewer actions lock the row (`SELECT ... FOR UPDATE`), so concurrent reviews of one item serialize.
A race between two activations on one slot that slips past the application check is refused by the
unique index and surfaces as `409 active_conflict`. Global items can be reviewed with the service
token only (403 otherwise). No role holds `DELETE`.

## 4. Feedback ingestion (`POST /feedback`)

One tenant transaction holds everything RLS must guard: the run lookup (404 for another tenant's
run), the event and every knowledge write. The event is inserted with `ON CONFLICT (run_id) DO
NOTHING`: the same `kind` again returns the original event with `idempotent_replay: true` and changes
nothing; a different `kind` is `409 run_already_reviewed`. The run's status is set from the kind.

| kind | Effect |
|---|---|
| `accepted` | `evidence_count + 1` and `confidence = min(0.99, confidence + 0.05)` on every item the run **applied**. Tenant items in the tenant transaction; global items afterwards in a service-role transaction, because a tenant connection must never write a global row. |
| `adjusted` | The extractor reads `diff = {field: {before, after}}`. Per changed field, in this order: `account` -> `account_mapping` (after must be a non-empty string or number); `after` equal to another invoice field's value -> `field_mapping`; `after` is a string that embeds invoice values (vendor or any string/number field of 3+ characters, longest first, never inside an already placed placeholder) -> `naming_convention` with the template; otherwise `booking_rule` with the literal (including `null` = "leave empty"). No-op changes are ignored and noted. Confidence 0.5. |
| `rejected` | `contested_count + 1` on applied items. If the suggestion had an account other than `UNMAPPED`, an `account_veto` candidate `{forbidden_accounts: [account]}` with confidence 0.3; otherwise a note. |
| `failed` | `code` in `{TIMEOUT, RATE_LIMIT, UPSTREAM_5XX}` is transient: nothing is created. Otherwise, with `error.doc_structure` (fallback: the invoice's), an `extraction_failure_pattern` whose rule holds the structural features, `error_signature = <code>[:<missing_field>]` and the `recovery_strategy` when given, all as lowercase identifiers. The error message and the invoice payload never enter the item. |

Persisting a candidate (`src/internal/feedback/persist-candidate.ts`):

1. An identical pending candidate (same tenant, type, slot and rule) is **strengthened**
   (`evidence_count + 1`, evidence link) instead of duplicated.
2. An identical active item is **reinforced** the same way: the reviewer confirmed what is already known.
3. An active veto plus a new veto on the slot become one veto with the union of accounts, stored as
   the **next version** (`supersedes_id` = the active veto), still a candidate.
4. Any other active item on the slot makes the candidate carry `supporting_context.conflicts_with`.
   Nothing is auto-superseded.

Every created item gets a `knowledge_evidence` row for the event. The extractor sits behind
`KnowledgeExtractor { extract(input): Promise<{candidates, notes}> }`.

## 5. Retrieval, the run graph and the mock agent

`POST /runs` accepts an optional `Idempotency-Key` header (1 to 128 characters of letters, digits,
`.`, `_`, `:` or `-`, unique per tenant). With a key, `startRun` first looks for an existing run and
replays it (`replayed: true`, HTTP 200, the stored output); otherwise it executes the graph. Two
concurrent calls with the same key both pass the lookup; the second insert fails on
`runs_tenant_idempotency_key`, and the loser reads the winner and replays it. Without a key every
call is a new run.

The run itself is a LangGraph `StateGraph` with three nodes inside the tenant transaction:

1. **retrieve**: anchors are derived from the invoice (`vendor=<v>`, `tenant`, and
   `doc_pattern=<sha1>` when `doc_structure` is present). One query returns the active, unexpired
   (`valid_until IS NULL OR valid_until > now()`) items of the tenant and of the global scope with
   those anchors. On the same slot the tenant item **shadows** the global one whatever the confidence,
   and the shadowed item is returned separately as `shadowed_global_knowledge`. Ranking: confidence
   descending, then most recent activation. Retrieval is by anchor rather than by field name so that
   a rule which adds a field the invoice does not carry is still found; there is no arbitrary cap,
   because the number of active items per anchor is bounded by the number of slots.
2. **generate**: `mockInvoiceAgent(invoice, knowledge)` is pure. Default account `6000`. Rules are
   applied in phases so later rules see the final field names: `field_mapping`, `booking_rule`,
   `naming_convention` (template rendered from the invoice's own values; skipped when a placeholder
   has no value), `account_mapping`, `extraction_failure_pattern` (sets `recovery_strategy`), and
   `account_veto` last (a forbidden account becomes `UNMAPPED`). An item that leaves the output as it
   already is counts as retrieved, not applied.
3. **trace**: the run row (input, full output, idempotency key) and one `run_knowledge_trace` row per
   retrieved and per applied item, with the version used.

The compiled graph is one shared instance; the tenant-scoped connection travels in `configurable`.

## 6. Conflicting and outdated knowledge

- **One active per slot** (database index). **Tenant over global** on the same slot (retrieval).
- A new candidate that disagrees with the active item is marked (`conflicts_with`); accepting it
  parks it (`pending_conflict_with`); a reviewer picks a winner. `new` supersedes the active item
  and links the chain; `existing` rejects the newcomer.
- Outdated knowledge leaves in three ways, never by deletion: a newer version or conflict winner
  (`superseded`), a reviewer (`disabled`), or an expiry date given on accept (`valid_until`,
  filtered in SQL). `contested_count` is a visible signal for the reviewer, not an automatic trigger.

## 7. Global promotion

Runs as `billay_service` (`npm run promote` or `POST /promotion/run`). Active tenant items are grouped
by `(type, subject_key)`. Gates, in order:

| # | Gate | When it fails |
|---|---|---|
| 1 | Type is `extraction_failure_pattern` | `refused`, with the reason the type never generalizes (account numbers are one tenant's chart of accounts, vetoes and booking values are bound to a vendor, naming templates are private conventions). |
| 2 | At least `PROMOTION_MIN_TENANTS` (default 3) distinct tenants | `skipped` with the count. |
| 3 | No global candidate, accepted or active item for the slot | `skipped`. |
| 4 | The sanitizer accepts the best-supported item | `refused` with the sanitizer's reason. |
| 5 | A platform reviewer accepts | The result is a global **candidate**: `scope = global`, `tenant_id = NULL`, `distinct_tenant_count = N`, `evidence_count` summed, `confidence` = the group's minimum, evidence links to every source event. |

**Sanitizer** (`src/internal/promotion/sanitize.ts`), allowlist strategy:

1. Keep `doc_type`, `error_signature`, `missing_field`, `recovery_strategy` and the structural
   features of `doc_structure`; strip and report everything else.
2. Refuse when nothing remains, and regenerate `rule_text` from the surviving structure: tenant free text is never copied.
3. Every string value must be a lowercase structural identifier (no prose, no proper nouns).
4. Residue check over the serialized output: IBAN, email, amounts, long digit runs, and every known
   tenant and vendor name (from `tenants.name` and every vendor seen in runs), matched as whole words
   with underscores counted as separators. Any hit refuses the candidate with the reason.

The safe failure is a false rejection (a vendor literally named "Table" would block `layout=table`),
and it is reported rather than silently dropped.

## 8. Traceability

- `run_knowledge_trace` stores `(run_id, knowledge_item_id, version, role)` for `retrieved` and
  `applied`. A later edit does not rewrite what a past run saw.
- The `POST /runs` response returns `applied_knowledge`, `retrieved_knowledge` and
  `shadowed_global_knowledge` (id, version, scope, type, slot, text, confidence) and `anchors`.
- `suggestion.notes` says, per applied item, what it changed.
- `GET /runs/:id` returns the run, its feedback event and the trace joined with each item's **current**
  status and version, so "this run used v1, which is now superseded" is a single read.
- Reinforcement and contestation read the `applied` trace, never the `retrieved` one.

## 9. Row-level security and roles

| Role | Attributes | Grants |
|---|---|---|
| `billay_app` | `NOBYPASSRLS` | `SELECT, INSERT, UPDATE` on runs, feedback_events, knowledge_items, knowledge_evidence, run_knowledge_trace; `SELECT` on tenants. No `DELETE`. |
| `billay_service` | `BYPASSRLS` | the same plus writes on tenants. No `DELETE`. |

Policies for `billay_app`, with `app_tenant_id() = NULLIF(current_setting('app.tenant_id', true), '')::uuid`:

| Table | SELECT | INSERT / UPDATE |
|---|---|---|
| `knowledge_items` | `scope = 'global' OR tenant_id = app_tenant_id()` | `scope = 'tenant' AND tenant_id = app_tenant_id()` |
| `tenants` | `id = app_tenant_id()` | none |
| `runs`, `feedback_events`, `knowledge_evidence` | `tenant_id = app_tenant_id()` | same |
| `run_knowledge_trace` | through the owning run | same |

Per request: `BEGIN; SELECT set_config('app.tenant_id', $1, true); ...; COMMIT;`. `set_config(..., true)`
is transaction-local and takes a bind parameter, which `SET LOCAL` cannot. The tables are owned by the
migration (admin) role; an owner would bypass RLS. `tests/rls.test.ts` proves that a `SELECT` with no
`WHERE` as tenant A returns A's rows and global rows only, that inserting a global or foreign row is
rejected, that updates against foreign rows affect zero rows, and that `DELETE` is denied for both roles.

**Secrets.** `src/config/env.ts` has no default for any password or token; a missing value stops the
process with the variable name, and a value still equal to a `.env.example` placeholder is reported
at startup (it is long enough to pass validation, which is why it must be named). The admin password
is optional so the API never needs it. The migration creates the roles without passwords;
`npm run migrate` applies them from the environment (`ALTER ROLE`, escaped), so rotation is "edit
`.env`, run migrate". The service token is compared in constant time and redacted from request logs.

**Migrations.** Files in `db/migrations` are applied in name order, all pending ones in a single
transaction that holds `pg_advisory_xact_lock(hashtext('schema_migrations'))`: a second migrator
started at the same time waits, then finds nothing to apply; a failing file leaves no half-applied
schema. The files are not idempotent on purpose; the `schema_migrations` registry is what makes a
second run safe.

## 10. HTTP

Prefix `/api/v1`. Success `{ data }`; errors `{ error: { code, message, requestId, details? } }`
with `x-request-id` on every reply.

| Method | Path | Actor | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness (database round trip). |
| GET | `/tenants` | any | Platform: every tenant. Tenant: itself. |
| POST | `/runs` | tenant | Run the agent: retrieve -> generate -> trace. Optional `Idempotency-Key` header; 201 on a new run, 200 on a replay. |
| GET | `/runs` | any | Recent runs (vendor, account, status). |
| GET | `/runs/:id` | any | The run, its feedback and its trace with current item status. |
| POST | `/feedback` | tenant | One reviewer decision for a run. |
| GET | `/knowledge` | any | Filter by `status`, `scope`, `tenant_id`, `type`, `subject_key`. |
| GET | `/knowledge/:id`, `/knowledge/:id/history` | any | One item; its version chain. |
| POST | `/knowledge/:id/accept` `resolve-conflict` `edit` `reject` `disable` | any (global: service) | Review actions. |
| POST | `/promotion/run` | service | The promotion job; returns the report. |

Actor: `X-Service-Token == SERVICE_TOKEN` -> service (`billay_service`); else `X-Tenant-Id: <uuid>`
-> tenant (`billay_app` + `set_config`); neither -> 401. This is the MVP stand-in for authentication;
the guarantee lives in RLS, and a JWT middleware would replace `src/http/actor.ts` only.

Error codes: `unauthorized`, `forbidden`, `validation_error`, `not_found`, `invalid_transition`,
`run_already_reviewed`, `active_conflict`, `bad_request`, `internal_error`.

## 11. Decisions log

- Slots (`anchor` + `subject_key`) instead of per-type keys; retrieval by anchor, uniqueness by slot.
- Field corrections are vendor-scoped; only an inferred template is tenant-wide; only
  `extraction_failure_pattern` is global.
- `runs.status` starts as `pending_review`; the feedback sets it.
- `POST /runs` is idempotent per tenant and `Idempotency-Key`; the whole output is stored so the replay is exact.
- Migrations run in one transaction under an advisory lock; `.env.example` placeholders are reported at startup.
- One feedback event per run; same kind = idempotent, different kind = 409.
- `account_veto` shares the `account` slot with `account_mapping`; repeated rejections extend the veto
  as a new version; rejecting `UNMAPPED` creates nothing.
- Confidence: candidates 0.5 (veto 0.3), `+0.05` per accepted run, cap `0.99`; rejection increments
  `contested_count` only.
- Global reinforcement runs in a second, service-role transaction after the tenant transaction commits.
- Structural identifiers are lowercase; error codes are normalized to lowercase in signatures.
- Per-type rule schemas: an edit must fit its type.
- `valid_until` is set by the reviewer on accept; expired items are filtered in SQL.
- No retrieval cap: everything active for the invoice's anchors is handed to the agent, ranked.
- `set_config('app.tenant_id', $1, true)` instead of `SET LOCAL` (bind parameters).
- No role has `DELETE`; tests and scenarios reset through the admin role only.
- Scenarios drive the real Fastify app in-process (`inject`) against the real database; tests run
  sequentially because they share it.
- Lint enforces complexity <= 10, functions <= 80 lines, files <= 300 lines; `knip` enforces no dead code.
