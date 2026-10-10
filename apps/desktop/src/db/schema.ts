/** Ordered, forward-only migrations. Never edit a shipped statement; append. */
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE servers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        client      TEXT NOT NULL,
        target      TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        installed   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        server_id   TEXT NOT NULL,
        server_name TEXT NOT NULL,
        client      TEXT NOT NULL,
        pid         INTEGER NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        server_info TEXT
      );
      CREATE INDEX idx_sessions_server ON sessions(server_id, started_at DESC);

      CREATE TABLE calls (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        server_id      TEXT NOT NULL,
        server_name    TEXT NOT NULL,
        client         TEXT NOT NULL,
        method         TEXT NOT NULL,
        tool           TEXT,
        args           TEXT,
        result         TEXT,
        error          TEXT,
        status         TEXT NOT NULL,
        decision       TEXT,
        decided_by     TEXT,
        rule_id        TEXT,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        duration_ms    INTEGER,
        result_bytes   INTEGER,
        token_estimate INTEGER,
        findings       TEXT NOT NULL DEFAULT '[]',
        finding_count  INTEGER NOT NULL DEFAULT 0,
        max_severity   TEXT NOT NULL DEFAULT 'none',
        redacted       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_calls_started ON calls(started_at DESC);
      CREATE INDEX idx_calls_server ON calls(server_id, started_at DESC);
      CREATE INDEX idx_calls_flagged ON calls(finding_count, started_at DESC);
      CREATE INDEX idx_calls_status ON calls(status, started_at DESC);

      CREATE TABLE tools (
        server_id     TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        schema        TEXT,
        fingerprint   TEXT NOT NULL,
        revision      INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        changed_at    INTEGER,
        PRIMARY KEY (server_id, name)
      );

      CREATE TABLE rules (
        id          TEXT PRIMARY KEY,
        enabled     INTEGER NOT NULL DEFAULT 1,
        priority    INTEGER NOT NULL DEFAULT 100,
        name        TEXT NOT NULL,
        description TEXT,
        match       TEXT NOT NULL,
        effect      TEXT NOT NULL,
        redact      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE grants (
        session_id TEXT NOT NULL,
        server_id  TEXT NOT NULL,
        tool       TEXT NOT NULL,
        scope      TEXT NOT NULL,
        effect     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, server_id, tool)
      );
    `
  }
  ,
  {
    version: 2,
    sql: `
      CREATE TABLE tool_prefs (
        server_id  TEXT NOT NULL,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, name)
      );
    `
  }
  ,
  {
    version: 3,
    sql: `ALTER TABLE sessions ADD COLUMN client_info TEXT;`
  }
  ,
  {
    version: 4,
    sql: `
      -- Local mirror of the official MCP Registry. Searching it remotely takes
      -- ~15s, so the catalogue is synced and queried on disk instead.
      CREATE TABLE catalog (
        name             TEXT PRIMARY KEY,
        title            TEXT NOT NULL DEFAULT '',
        description      TEXT NOT NULL DEFAULT '',
        version          TEXT NOT NULL DEFAULT '',
        namespace        TEXT NOT NULL DEFAULT '',
        repository_url   TEXT,
        website_url      TEXT,
        status           TEXT NOT NULL DEFAULT 'unknown',
        published_at     INTEGER,
        updated_at       INTEGER,
        kind             TEXT NOT NULL DEFAULT 'none',
        packages         TEXT NOT NULL DEFAULT '[]',
        remotes          TEXT NOT NULL DEFAULT '[]',
        downloads        INTEGER,
        downloads_source TEXT,
        categories       TEXT NOT NULL DEFAULT '[]',
        synced_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_catalog_updated ON catalog(updated_at DESC);
      CREATE INDEX idx_catalog_downloads ON catalog(downloads DESC);
      CREATE INDEX idx_catalog_namespace ON catalog(namespace);

      -- One server definition can be wired into several AI clients.
      CREATE TABLE server_clients (
        server_id  TEXT NOT NULL,
        client     TEXT NOT NULL,
        installed  INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, client)
      );

      -- Carry the existing single-client wiring into the new model.
      INSERT INTO server_clients (server_id, client, installed, updated_at)
        SELECT id, client, installed, updated_at FROM servers;

      -- Where an installed server came from, when it came from the catalogue.
      ALTER TABLE servers ADD COLUMN catalog_name TEXT;

      CREATE TABLE sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
  ,
  {
    version: 5,
    sql: `ALTER TABLE catalog ADD COLUMN icon_url TEXT;`
  }
  ,
  {
    version: 6,
    sql: `
      -- The operator's own annotations on a catalogue entry. Kept in its own
      -- table so a registry sync can replace the entry wholesale without
      -- destroying curation, and so the UI can say who asserted what.
      CREATE TABLE catalog_overlay (
        key           TEXT PRIMARY KEY,
        tier          TEXT NOT NULL DEFAULT 'unknown',
        featured_rank INTEGER,
        tags          TEXT NOT NULL DEFAULT '[]',
        notes         TEXT,
        rating        INTEGER,
        hidden        INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_overlay_featured ON catalog_overlay(featured_rank);
      CREATE INDEX idx_overlay_tier ON catalog_overlay(tier);

      -- Servers the registry has never heard of: a local command, a
      -- self-hosted endpoint, or a git repository.
      CREATE TABLE custom_entries (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        command     TEXT,
        args        TEXT NOT NULL DEFAULT '[]',
        env         TEXT NOT NULL DEFAULT '{}',
        url         TEXT,
        git_ref     TEXT,
        cwd         TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_custom_source ON custom_entries(source);

      -- Which catalogue entry an installed server came from, so post-install
      -- settings can be traced back to what was installed.
      ALTER TABLE servers ADD COLUMN catalogue_key TEXT;
    `
  }
  ,
  {
    version: 7,
    sql: `
      -- What a connection test actually observed about authentication, which
      -- beats what a publisher declared: most OAuth servers declare nothing.
      ALTER TABLE catalog_overlay ADD COLUMN auth_observed TEXT;
    `
  }
  ,
  {
    version: 8,
    sql: `
      -- Which icon URL won for a domain, so a cold start does not have to
      -- rediscover it. The bytes were already cached on disk; the *decision*
      -- was not, so every launch re-fetched each vendor's homepage to work out
      -- again what it had worked out before. NULL icon_url is a real answer:
      -- "this domain has no usable icon", worth remembering so eight candidate
      -- probes are not repeated either.
      CREATE TABLE icon_resolution (
        domain      TEXT PRIMARY KEY,
        icon_url    TEXT,
        resolved_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 9,
    sql: `CREATE TABLE action_grants (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, serverId TEXT NOT NULL,
      tool TEXT NOT NULL, argsHash TEXT NOT NULL, expiresAt INTEGER NOT NULL,
      remaining INTEGER NOT NULL CHECK(remaining >= 0), revokedAt INTEGER,
      createdAt INTEGER NOT NULL
    );`
  },
  {
    version: 10,
    sql: `
      -- Grants move from an exact digest of all arguments to argument
      -- *constraints*. The digest could only ever match a literal retry, so no
      -- stored grant is worth migrating: any row here is at most 30 minutes old
      -- and authorises nothing a user would miss. Dropping is safer than
      -- inventing constraints on their behalf.
      DROP TABLE IF EXISTS action_grants;

      CREATE TABLE action_grants (
        id          TEXT PRIMARY KEY,
        -- NULL means the grant survives a client restart within its expiry.
        session_id  TEXT,
        server_id   TEXT NOT NULL,
        tools       TEXT NOT NULL,
        constraints TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        expires_at  INTEGER NOT NULL,
        remaining   INTEGER NOT NULL CHECK(remaining >= 0),
        revoked_at  INTEGER,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_grants_live ON action_grants(server_id, expires_at DESC);
    `
  },
  {
    version: 11,
    sql: `
      -- The Claude Code hook decides a call in one process (PreToolUse) and
      -- learns its outcome in another (PostToolUse), with no shared id between
      -- them. This is the key both sides derive from session, tool and
      -- arguments so the second can finish the row the first opened.
      ALTER TABLE calls ADD COLUMN hook_key TEXT;
      CREATE INDEX idx_calls_hook_key ON calls(hook_key, started_at DESC);
    `
  },
  {
    version: 12,
    // Result trimming and repeat notes change what the model sees; the trace
    // has to say so, or the stored result and the model's view disagree silently.
    sql: `ALTER TABLE calls ADD COLUMN shaping TEXT;`
  },

]
