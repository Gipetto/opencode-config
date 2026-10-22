---
name: postgres-schema-first
description: Safe, schema-first workflow for running SQL against PostgreSQL through an MCP server or psql. Use this skill whenever you are about to write or run ANY query against a Postgres database, debug data in a database, join tables, aggregate or filter on dates/numbers, or recover from a SQL error (column/relation does not exist, operator does not exist, function does not exist, syntax error), even if the schema seems obvious or you think you remember it.
---

# Postgres: look at the schema first

Most failed Postgres calls come from the same loop: guess a table or column name, get
`does not exist`, guess again. Each guess costs a tool call and teaches nothing. Reading
the schema first costs one or two calls and removes almost every error of that kind.
Column names are not predictable (`created_at` vs `inserted_at` vs `ts`), and ID types
differ between tables (bigint in one, uuid in another), so memory and convention are
unreliable here.

## Workflow

1. **Check for a project schema map first.** Look for `postgres-schema-map.md` in the
   repo root, then `docs/postgres-schema-map.md`, of the project you are querying. A map
   that lives in the repo belongs to that repo's database, so it never gets crossed with
    another project's schema. Only trust it for the database you are connected to: maps
    carry both a `current_database():` and a `connection:` (host:port + environment)
    label line. A database name alone is not discriminating — every Supabase stack
    reports `postgres` — and locality (the map lives in this repo) is the primary guard;
    the labels catch in-repo environment drift. When the connection cannot be confirmed
    from the labels, the map should provide a sentinel query (one cheap query whose
    result identifies this database, e.g. existence of a project-specific table) and the
    agent runs it; mismatch or missing sentinel means fall through to step 3
    introspection. If no map exists in the repo, run the
   introspection queries in step 3, and if you have write access and the schema will be
    reused, save the result to `postgres-schema-map.md` at the repo root using the
    template in [postgres-schema-map.template.md](references/postgres-schema-map.template.md) — start the file with the output
    of `SELECT current_database();` and note it should be regenerated after migrations.
    Data sections of a map contain pasted query output only — no remembered columns, no
    reconstructed rows — and every conclusion in a map (such as a join-key annotation)
    must name the query that proved it.
 2. **Generic fallback:** the skill's own [postgres-schema-map.template.md](references/postgres-schema-map.template.md) holds
   the generation queries and a catalog of guessed names that previously failed; it is
   not a schema. Use it for the queries and the failure list, never as column truth.
3. **Introspect every table you will touch** before writing the query (queries below).
   Get column names, data types, and foreign keys. Do this once per table per session;
   do not re-run it for tables you already inspected.
4. **Write the query using only names you have seen.** Qualify tables with their schema
   when they are not in `public`. Add `LIMIT` to exploratory selects.
5. **If it errors, do not re-guess.** Re-read the error, then go back to step 3 for the
   table or column named in it. A second blind attempt is the failure pattern this skill
   exists to prevent.

## Introspection queries

Find a table when you do not know its exact name or schema (search all schemas, not just
`public`; the table may live elsewhere or be named differently):

```sql
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  AND table_name ILIKE '%flag%'
ORDER BY table_schema, table_name;
```

Columns and types for the tables you plan to use. `data_type` is `USER-DEFINED` for
enums; `udt_name` then gives the enum's type name:

```sql
SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('profiles', 'users')
ORDER BY table_name, ordinal_position;
```

Primary and foreign keys, which tell you the correct join columns:

```sql
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype IN ('p', 'f')
  AND conrelid = ANY (ARRAY['public.profiles', 'public.users']::regclass[]);
```

A few real rows, to see what the values look like (essential for text columns that hold
numbers or dates):

```sql
SELECT * FROM public.profiles LIMIT 3;
```

Server version, when a function seems to be missing: `SELECT version();`

## Joins and ID types

`operator does not exist: bigint = uuid` (and its mirror images) means you are comparing
columns of different types, which almost always means you picked the wrong join column,
not that you need a cast. Look at the foreign key constraints from the query above and
join on the column they point at. Casting both sides to text makes the error disappear
and the query return nothing or the wrong rows, so do not do it to silence the error.
If a cast really is needed (for example a text column storing a uuid), confirm that from
the sample rows first.

## Type and function pitfalls

These come up repeatedly. Check the column's actual `data_type` before applying them.

- **`round(x, n)` needs `numeric`.** `round(double precision, integer)` does not exist,
  and neither does `round(text, integer)`. Use `round(x::numeric, 2)`. If the column is
  text, confirm the values are actually numeric before casting.
- **`extract(field FROM x)` needs a timestamp, date or interval.** Applying it to `text`
  or `integer` fails. Cast a text column with `col::timestamptz` once you have confirmed
  its format. For integer epoch seconds, use `to_timestamp(col)` first.
- **Relative dates are intervals, not date casts.** `'7 days'::date` is invalid. Write
  `now() - interval '7 days'` and compare against a real timestamp column.
- **`= ANY(...)` needs an array on the right.** Use `col = ANY($1::bigint[])`, or
  `ANY (ARRAY[1,2,3])`, or just `IN (1,2,3)`. Match the array's element type to the
  column (`uuid[]` for uuid columns).
- **Reserved words as names.** `offset`, `limit`, `user`, `order`, `group`, `table` and
  similar cannot be used bare as aliases or column names. Quote them (`"offset"`) or
  pick another alias. A `syntax error at or near "offset"` is this, unless you meant the
  `OFFSET` clause, which goes after `LIMIT`/`ORDER BY`.
- **`missing FROM-clause entry for table "q"`** means an alias is referenced where it is
  not in scope: it is not in `FROM`, it belongs to a different subquery or CTE, or a
  subquery in `FROM` needs `LATERAL` to see an outer alias. Check every alias used in
  `SELECT`/`WHERE`/`ON` against the `FROM` clause.
- **Catalog functions vary by version.** For `pg_get_acl` or other catalog helpers, check
  `SELECT version();` and the function's real signature before calling; on older servers
  read `relacl` from `pg_class` directly.

## Do not retry these

- **Authentication failures** (`password authentication failed for user ...`). This is a
  server or credential configuration problem, and no SQL change fixes it. Stop after
  the first occurrence, report the exact error to the user, and do not retry or search for
  credentials.
- **Argument validation errors from the MCP layer** (for example `invalid_union` or
  `expected "string"` with a `path`). The `path` names the argument that has the wrong
  shape. The SQL is not the problem. Fix the argument and do not resend the same payload.

## Safety defaults

- Prefer read-only statements (`SELECT`, `EXPLAIN`) unless the user clearly asked for a
  write. Never run `UPDATE`, `DELETE`, DDL or `TRUNCATE` on the strength of a guess.
- Use parameters for literal values where the tool supports them.
- For exploratory queries on large tables, start with `LIMIT` and `EXPLAIN` before
  scanning.
- The hard read-only guarantee comes from the MCP server's configuration (a read-only
  SQL tool), not from this skill's rules. These rules reduce error rate and prevent
  accidental writes by convention; do not treat them as a security boundary.

