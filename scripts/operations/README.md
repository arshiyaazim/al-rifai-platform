Canonical procedure: ../../docs/WORKFLOW_RELEASE.md, 2026-10-16 owner reconciliation section.
These tools emit aggregate diagnostics only. Scanner reads individually consistent
SQLite snapshots, uses flock plus PG advisory lock, and invokes only the existing
app image. No MCP registration, history request, outbound or cursor reset.
Backup creates PostgreSQL16 custom dump with matching exported snapshot, consistent
SQLite backup snapshots, encrypted config/source/globals/state and optional image.
Restore rehearsal is restricted by an exact empty disposable-database guard.
Root GPG key is deliberately NOT included in the encrypted archive. Keep its
owner-controlled independent copy; same-host encryption is not disaster recovery.
