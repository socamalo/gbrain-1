# Minions fix — repairing a half-migrated v0.11.0 install

**tl;dr:** if your gbrain upgrade to v0.11.0 left Minions half-wired
(no preferences, autopilot still inline, or cron jobs still on
`agentTurn`), run:

```bash
gbrain upgrade && gbrain apply-migrations --yes
```

If you're stuck on a v0.11.0 binary that predates `apply-migrations`,
paste the stopgap:

```bash
curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/v0.11.1/scripts/fix-v0.11.0.sh | bash
```

Then upgrade + run `apply-migrations` once v0.11.1 is installed.

## What went wrong

The v0.11.0 release shipped the Minions schema, worker, queue, and
migration skill at `skills/migrations/v0.11.0.md`. But `gbrain upgrade`'s
`runPostUpgrade()` only printed the feature pitch — it never executed
the migration steps. Users ended up with:

- Schema migrated to v7 (thanks to `gbrain init` on upgrade).
- Minions table created.
- Worker handlers registered (but no worker daemon running).
- No `~/.gbrain/preferences.json` (so `minion_mode` was unset).
- Autopilot still running sync/extract/embed inline, not dispatching
  through Minions.
- AGENTS.md + cron manifests still referencing the old `sessions_spawn`
  + `agentTurn` routes.

## The fix (v0.11.1 binary or later)

`gbrain apply-migrations` is the canonical repair. It reads
`~/.gbrain/migrations/completed.jsonl`, sees v0.11.0 is pending (or
stopgap-partial), and runs the orchestrator's seven phases:

```
A. Schema        gbrain init --migrate-only
B. Smoke         gbrain jobs smoke
C. Mode          prompt (or --yes default pain_triggered)
D. Prefs         write ~/.gbrain/preferences.json
E. Host          AGENTS.md marker injection + cron rewrites for gbrain
                 builtins; JSONL TODOs for host-specific handlers
F. Install       gbrain autopilot --install (env-aware)
G. Record        append completed.jsonl status:"complete"
```

If Phase E emits TODOs for host-specific handlers (Wintermute's
~29 non-gbrain crons, for example), the migration finishes with
`status: "partial"`. Your host agent walks the TODOs using
`skills/migrations/v0.11.0.md` + `docs/guides/plugin-handlers.md`, ships
handler registrations in the host repo, then you re-run
`gbrain apply-migrations --yes` — the newly-registerable cron entries
get rewritten and the JSONL rows mark `status: "complete"`.

## The stopgap (v0.11.0 binary, no apply-migrations yet)

`scripts/fix-v0.11.0.sh` is a shell script that does what apply-migrations
does from a bash environment without depending on any new CLI. It:

1. Runs `gbrain init --migrate-only` to ensure schema v7.
2. Runs `gbrain jobs smoke`.
3. Prompts for `minion_mode` (pain_triggered default on non-TTY).
4. Writes `~/.gbrain/preferences.json` atomically.
5. Appends `~/.gbrain/migrations/completed.jsonl` with
   `status: "partial"` + `apply_migrations_pending: true` so a later
   v0.11.1 `apply-migrations` run picks up where it left off.
6. Detects host agent repos and **prints** rewrite instructions (never
   auto-edits from a curl-piped script — too high blast radius).
7. Tells the user to run `gbrain autopilot --install` as the one-stop
   finisher (autopilot forks the Minions worker as a child; no separate
   daemon to manage).

Once v0.11.1 is installed, the stopgap retires: the canonical fix
becomes `gbrain upgrade && gbrain apply-migrations`.

## Verify the fix landed

```bash
# 1. Preferences exist and are readable
cat ~/.gbrain/preferences.json

# 2. Migration recorded
cat ~/.gbrain/migrations/completed.jsonl

# 3. Autopilot is supervising a Minions worker child
gbrain autopilot --status
ps aux | grep 'jobs work'

# 4. Jobs show up in the queue
gbrain jobs list

# 5. Any host-specific TODOs still pending
cat ~/.gbrain/migrations/pending-host-work.jsonl 2>/dev/null || echo "(none — all host work is done)"
```

## If the fix fails

Each phase is idempotent. Re-running is safe. Common failure modes:

- **Phase B smoke fails:** the schema didn't apply. Check
  `~/.gbrain/config.json` has a valid `database_url` (or `database_path`
  for PGLite). Run `gbrain init --migrate-only` directly and look at
  the error.
- **Phase F install fails:** your host environment doesn't match any
  detected target. Pass `--target <macos|linux-systemd|ephemeral-container|linux-cron>`
  explicitly.
- **Pending host work never clears:** your host agent hasn't shipped
  handler registrations yet. Read
  `~/.gbrain/migrations/pending-host-work.jsonl`, open
  `skills/migrations/v0.11.0.md`, and follow the host-agent instruction
  manual.

## Related

- `skills/migrations/v0.11.0.md` — full migration skill for host agents.
- `docs/guides/plugin-handlers.md` — plugin contract for host-specific
  handlers.
- `skills/conventions/cron-via-minions.md` — the canonical cron rewrite
  pattern.
