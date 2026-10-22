# Postgres schema map — <project>

current_database(): <FILL IN — run SELECT current_database();>
connection: <FILL IN — host:port + environment, e.g. postgres@127.0.0.1:54322 (Supabase local stack)>
sentinel query: <FILL IN — one cheap query identifying this DB, e.g. SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='<a table only this project has>' — must return exactly one row>

This is the per-project schema map used by the `postgres-schema-first` skill for the
<project> database. Skill agents refuse to trust a map without matching
`current_database():` and `connection:` labels — and, when the connection cannot be
confirmed from the labels, without a sentinel query that identifies the database — so
the label lines above must be filled in before this file is relied upon. It is never
column truth on its own.

Provenance rule: data sections contain pasted query output only. Any conclusion (like a
join-key annotation) must name the query that proved it.

Freshness rule: regenerate the sections below after migrations. If a query errors or
touches a table not listed here, introspect live instead of trusting this file.

## How to generate

Run the queries below against the target database and paste the results into the
sections below. The first query lists every `id` and `*_id` / `*uuid*` column with its
type, which is where the `bigint = uuid` mistakes come from:

```sql
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  AND (column_name = 'id' OR column_name LIKE '%\_id' OR column_name LIKE '%uuid%')
ORDER BY table_schema, table_name, ordinal_position;
```

For a fuller map, also dump table and column names per schema:

```sql
SELECT table_schema, table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS columns
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
GROUP BY table_schema, table_name
ORDER BY table_schema, table_name;
```

## ID types (fill in)

<!-- table.column: type, e.g. profiles.id: uuid ; users.id: bigint -->

## Join keys that are easy to get wrong (fill in)

<!-- Name the trap, per FK, with the proving query cited:
     e.g. answers.question_id uuid -> questions.uuid uuid, NOT questions.id bigint
     (proved by pg_constraint, <date>). Note ON DELETE behavior where it matters.
     List FK-less but type-matched relationships separately, marked by-convention. -->

## Per-table columns (fill in)

<!-- One line per table, from the fuller dump query above:
     **table_name**: col type, col type, ...
     Flag columns whose type is surprising (text holding ids/dates, USER-DEFINED
     domains — record the udt_name for these). This is the section agents consult
     most; keep it complete for the public schema. -->

## Names that failed in a reference project — check the pattern, not the names

Columns the agents guessed that failed: `created_at` (several tables), `inserted_at`,
`status`, `p.uuid`, `p.username`, `lu.created_at`. Relations that failed: `flags`,
`public.flags`, `user_feature_flags`, `supabase_migrations.dias_version`. Check the real
names with the introspection queries; do not retry these guesses. Once a real name is
confirmed via introspection, record the correct name next to each failed guess rather
than deleting this section — the failed-guess list prevents re-guessing. These names
come from one project's scar tissue; most will be meaningless in yours. Keep the ones
your own sessions hit, add yours to them, and record the verified replacement next to
each.
