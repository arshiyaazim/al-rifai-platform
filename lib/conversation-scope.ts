// Owner-approved conversation scope and canonical PN/LID identity resolution.
//
// Identifiers are configuration data in the database (public.conversation_scope,
// public.whatsapp_identity_aliases for the legacy path; public.escort_roster and
// public.escort_roster_channel for the roster path). They are never compiled into
// source and never committed. Every loader fails closed: an empty or unreachable
// scope disables ingestion instead of falling back to an implicit or wider scope.
//
// Phase C adds a SHADOW mode that compares the legacy scope against the roster
// scope and promotes to roster-backed routing only after a clean observation
// period. Comparison state is persisted in public.roster_shadow_state because the
// ingestion worker and the /api/health route are separate processes and because
// promotion must survive a restart.

export type Domain = 'CASH' | 'VESSEL';
export type ConversationType = 'DIRECT' | 'GROUP';
export type RosterSource = 'STATIC' | 'SHADOW' | 'DB';
export type ShadowMode = 'SHADOW' | 'DB';

export type ApprovedConversation = {
  accountId: string;
  canonicalChatJid: string;
  domain: Domain;
  conversationType: ConversationType;
  displayName: string;
  canonicalPersonRef: string | null;
  aliases: string[];
};

export type CanonicalIdentity = {
  personRef: string;
  pnBare: string | null;
  lidBare: string | null;
  savedName: string | null;
  profileName: string | null;
  verification: 'BRIDGE_LID_MAP' | 'OWNER_PROVIDED' | 'ROSTER_DERIVED' | 'UNRESOLVED';
};

export type SenderResolution = {
  personRef: string | null;
  matched: 'PN' | 'LID' | 'NONE';
  systemRow: boolean;
  savedName: string | null;
  profileName: string | null;
};

export type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export const CACHE_TTL_MS = 60_000;

/** SHADOW logs at most once per real 10 minutes. In-memory is acceptable: worst case one extra line after a restart. */
export const SHADOW_LOG_THROTTLE_MS = 10 * 60 * 1000;

export function bareIdentifier(value: string | null | undefined): string {
  if (!value) return '';
  return String(value).replace(/@.*$/, '').replace(/:\d+$/, '').trim();
}

export type ConversationScope = {
  readonly conversations: ApprovedConversation[];
  readonly identities: CanonicalIdentity[];
  byChat(chatJid: string): ApprovedConversation | null;
  domainOf(chatJid: string): Domain | null;
  isApproved(chatJid: string): boolean;
  chatsFor(domain: Domain): string[];
  /** Canonical chat plus every alias, for ingestion and routing. */
  ingestionChats(): string[];
  canonicalChatFor(chatJid: string): string | null;
  resolveSender(chatJid: string, senderJid: string | null | undefined): SenderResolution;
  identityForBare(bare: string): CanonicalIdentity | null;
};

export type ShadowComparisonDetail = {
  /** Present in the roster scope but not in the legacy scope. */
  missing_in_static: string[];
  /** Present in the legacy scope but not in the roster scope. */
  extra_in_static: string[];
  domain_mismatch: Array<{chat: string; static: string | null; roster: string | null}>;
  type_mismatch: Array<{chat: string; static: string | null; roster: string | null}>;
  /** Same chat, different canonical person reference (business attribution key). */
  person_ref_mismatch: Array<{chat: string; static: string | null; roster: string | null}>;
  identity_mismatch: Array<{pn: string; static: string | null; roster: string | null}>;
};

export type ShadowComparison = {
  /** 0 means the two scopes are equivalent. */
  total: number;
  staticCount: number;
  dbCount: number;
  detail: ShadowComparisonDetail;
};

export type RosterShadowState = {
  mode: ShadowMode;
  cycles_completed: number;
  diffs_found: number;
  started_at: string | null;
  auto_promote_at: string | null;
  auto_promote_blocked: boolean;
  last_check_at: string | null;
  last_diff_detail: ShadowComparisonDetail | null;
};

export type ShadowConfig = {
  startedAt: string;
  autoPromoteAt: string;
  durationHours: number;
};

const SHADOW_COLUMNS =
  'mode, cycles_completed, diffs_found, started_at, auto_promote_at, auto_promote_blocked, last_check_at, last_diff_detail';

let lastShadowLogAt = 0;

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.startsWith('{')) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map((v) => v.replace(/^"|"$/g, '')) : [];
  }
  return [];
}

function digitsOnly(value: string | null | undefined): string {
  return value ? String(value).replace(/[^0-9]/g, '') : '';
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function assembleScope(
  conversations: ApprovedConversation[],
  identities: CanonicalIdentity[],
): ConversationScope {
  if (!conversations.length) throw new Error('APPROVED_SCOPE_EMPTY');
  const chatIndex = new Map<string, ApprovedConversation>();
  for (const conversation of conversations) {
    chatIndex.set(conversation.canonicalChatJid, conversation);
    for (const alias of conversation.aliases) chatIndex.set(alias, conversation);
  }
  const byPn = new Map<string, CanonicalIdentity>();
  const byLid = new Map<string, CanonicalIdentity>();
  for (const identity of identities) {
    if (identity.pnBare) byPn.set(identity.pnBare, identity);
    if (identity.lidBare) byLid.set(identity.lidBare, identity);
  }
  return {
    conversations,
    identities,
    byChat: (chatJid) => chatIndex.get(chatJid) ?? null,
    domainOf: (chatJid) => chatIndex.get(chatJid)?.domain ?? null,
    isApproved: (chatJid) => chatIndex.has(chatJid),
    chatsFor: (domain) =>
      conversations.filter((c) => c.domain === domain).flatMap((c) => [c.canonicalChatJid, ...c.aliases]),
    ingestionChats: () => conversations.flatMap((c) => [c.canonicalChatJid, ...c.aliases]),
    canonicalChatFor: (chatJid) => chatIndex.get(chatJid)?.canonicalChatJid ?? null,
    identityForBare: (bare) => byPn.get(bare) ?? byLid.get(bare) ?? null,
    resolveSender: (chatJid, senderJid) => {
      const bare = bareIdentifier(senderJid);
      // A group/system row carries the conversation's own identifier as "sender".
      // It is not a person and must never be attributed to a human.
      const systemRow = !!bare && bare === bareIdentifier(chatJid);
      if (systemRow) return { personRef: null, matched: 'NONE', systemRow: true, savedName: null, profileName: null };
      const identity = byPn.get(bare) ?? byLid.get(bare) ?? null;
      if (!identity) return { personRef: null, matched: 'NONE', systemRow: false, savedName: null, profileName: null };
      return {
        personRef: identity.personRef,
        matched: byPn.has(bare) ? 'PN' : 'LID',
        systemRow: false,
        savedName: identity.savedName,
        profileName: identity.profileName,
      };
    },
  };
}

export function buildConversationScope(
  conversationRows: Array<Record<string, unknown>>,
  identityRows: Array<Record<string, unknown>>,
): ConversationScope {
  const conversations: ApprovedConversation[] = conversationRows.map((row) => ({
    accountId: String(row.account_id),
    canonicalChatJid: String(row.canonical_chat_jid),
    domain: String(row.domain) as Domain,
    conversationType: String(row.conversation_type) as ConversationType,
    displayName: String(row.display_name),
    canonicalPersonRef: row.canonical_person_ref ? String(row.canonical_person_ref) : null,
    aliases: asStrings(row.alias_chat_jids),
  }));
  const identities: CanonicalIdentity[] = identityRows.map((row) => ({
    personRef: String(row.canonical_person_ref),
    pnBare: row.pn_bare ? String(row.pn_bare) : null,
    lidBare: row.lid_bare ? String(row.lid_bare) : null,
    savedName: row.saved_name ? String(row.saved_name) : null,
    profileName: row.profile_name ? String(row.profile_name) : null,
    verification: String(row.verification) as CanonicalIdentity['verification'],
  }));
  return assembleScope(conversations, identities);
}

/** Legacy platform of record: public.conversation_scope + public.whatsapp_identity_aliases. */
export async function loadConversationScope(db: Queryable): Promise<ConversationScope> {
  const [conversationRows, identityRows] = await Promise.all([
    db.query(
      `SELECT account_id,canonical_chat_jid,domain,conversation_type,display_name,
              canonical_person_ref,alias_chat_jids
       FROM public.conversation_scope
       WHERE active=true AND account_id='wa-01'
       ORDER BY domain DESC,conversation_type,canonical_chat_jid`,
    ),
    db.query(
      `SELECT canonical_person_ref,pn_bare,lid_bare,saved_name,profile_name,verification
       FROM public.whatsapp_identity_aliases
       WHERE scope_account='wa-01'
       ORDER BY canonical_person_ref`,
    ),
  ]);
  return buildConversationScope(conversationRows.rows, identityRows.rows);
}

/**
 * Roster platform of record: public.escort_roster + public.escort_roster_channel.
 *
 * Reads the roster TABLES directly rather than the Phase B compatibility views,
 * because those views are themselves derived from the legacy tables. Comparing
 * legacy against a legacy-derived view would always report zero differences.
 *
 * No role filter is applied: the roster IS the scope. Any active person is in
 * ingestion scope regardless of role (ESCORT_CLIENT, ACCOUNTANT, OWNER). The
 * active flag is the on/off switch, so removing someone from scope means
 * deactivating them — never narrowing this query. A role whitelist here would
 * reintroduce the hardcoded-logic defect this unification exists to remove, and
 * would silently drop ACCOUNTANT/OWNER rows.
 *
 * Identity set is restricted to people who own a DIRECT channel, which is the same
 * population the legacy identity table describes (people with a direct conversation).
 */
export async function loadRosterScope(db: Queryable): Promise<ConversationScope> {
  const [personRows, channelRows] = await Promise.all([
    db.query(
      `SELECT id, COALESCE(canonical_person_ref, id) AS person_ref, display_name, phone
       FROM public.escort_roster
       WHERE account_id='wa-01' AND active=true
       ORDER BY id`,
    ),
    db.query(
      `SELECT roster_id, chat_jid, participant_jid, channel_role, domain
       FROM public.escort_roster_channel
       WHERE account_id='wa-01' AND active=true
       ORDER BY roster_id, channel_role, chat_jid, participant_jid`,
    ),
  ]);

  // `person_ref` is the legacy-compatible identity key: the roster keeps the
  // platform-of-record value in canonical_person_ref and falls back to the row id
  // for group-only participants that never existed in the legacy identity table.
  type PersonRow = { id: string; person_ref: string; display_name: string; phone: string | null };
  type ChannelRow = { roster_id: string; chat_jid: string; participant_jid: string | null; channel_role: string; domain: string };

  const persons = personRows.rows as unknown as PersonRow[];
  const channels = channelRows.rows as unknown as ChannelRow[];
  const personById = new Map(persons.map((p) => [p.id, p]));

  const directs = new Map<string, { person: PersonRow; domain: Domain }>();
  const groups = new Map<string, Domain>();
  const lidByPerson = new Map<string, Set<string>>();

  for (const channel of channels) {
    const person = personById.get(channel.roster_id);
    if (!person) continue;
    if (channel.channel_role === 'DIRECT') {
      if (!directs.has(channel.chat_jid)) {
        directs.set(channel.chat_jid, { person, domain: channel.domain as Domain });
      }
      if (channel.participant_jid && channel.participant_jid.endsWith('@lid')) {
        const set = lidByPerson.get(person.id) ?? new Set<string>();
        // Keep the full JID: aliases are ingestion chat addresses (matching the
        // legacy alias_chat_jids format, e.g. "166082241384593@lid"), while the
        // identity registration uses the bare value below.
        set.add(channel.participant_jid);
        lidByPerson.set(person.id, set);
      }
    } else if (channel.channel_role === 'GROUP') {
      if (!groups.has(channel.chat_jid)) groups.set(channel.chat_jid, channel.domain as Domain);
    }
  }

  const conversations: ApprovedConversation[] = [];
  for (const [chatJid, entry] of directs) {
    conversations.push({
      accountId: 'wa-01',
      canonicalChatJid: chatJid,
      domain: entry.domain,
      conversationType: 'DIRECT',
      displayName: entry.person.display_name,
      canonicalPersonRef: entry.person.person_ref,
      aliases: [...(lidByPerson.get(entry.person.id) ?? [])].sort(),
    });
  }
  for (const [chatJid, domain] of groups) {
    conversations.push({
      accountId: 'wa-01',
      canonicalChatJid: chatJid,
      domain,
      conversationType: 'GROUP',
      displayName: chatJid,
      canonicalPersonRef: null,
      aliases: [],
    });
  }
  conversations.sort((a, b) =>
    a.domain === b.domain
      ? a.conversationType === b.conversationType
        ? a.canonicalChatJid.localeCompare(b.canonicalChatJid)
        : a.conversationType.localeCompare(b.conversationType)
      : b.domain.localeCompare(a.domain),
  );

  const identities: CanonicalIdentity[] = [];
  const seen = new Set<string>();
  for (const entry of directs.values()) {
    if (seen.has(entry.person.id)) continue;
    seen.add(entry.person.id);
    const pn = digitsOnly(entry.person.phone);
    if (!pn) continue;
    const lids = [...(lidByPerson.get(entry.person.id) ?? [])].sort();
    identities.push({
      personRef: entry.person.person_ref,
      pnBare: pn,
      lidBare: lids.length ? bareIdentifier(lids[0]) : null,
      savedName: entry.person.display_name,
      profileName: null,
      verification: 'ROSTER_DERIVED',
    });
  }
  identities.sort((a, b) => a.personRef.localeCompare(b.personRef));

  return assembleScope(conversations, identities);
}

function chatKeySet(scope: ConversationScope): Set<string> {
  const keys = new Set<string>();
  for (const conversation of scope.conversations) {
    keys.add(conversation.canonicalChatJid);
    for (const alias of conversation.aliases) keys.add(alias);
  }
  return keys;
}

function chatIndex(scope: ConversationScope): Map<string, ApprovedConversation> {
  const index = new Map<string, ApprovedConversation>();
  for (const conversation of scope.conversations) {
    index.set(conversation.canonicalChatJid, conversation);
    for (const alias of conversation.aliases) index.set(alias, conversation);
  }
  return index;
}

function identityPairs(scope: ConversationScope): Map<string, string | null> {
  const pairs = new Map<string, string | null>();
  for (const identity of scope.identities) {
    if (identity.pnBare) pairs.set(identity.pnBare, identity.lidBare ?? null);
  }
  return pairs;
}

/**
 * Set-based comparison. Order never counts as a difference; only membership and
 * the fields that govern ingestion are compared. display_name, verification and
 * evidence_ref are deliberately excluded because they differ by design.
 */
export function compareScopes(staticScope: ConversationScope, dbScope: ConversationScope): ShadowComparison {
  const staticKeys = chatKeySet(staticScope);
  const dbKeys = chatKeySet(dbScope);

  const missing_in_static = [...dbKeys].filter((key) => !staticKeys.has(key)).sort();
  const extra_in_static = [...staticKeys].filter((key) => !dbKeys.has(key)).sort();

  const staticIndex = chatIndex(staticScope);
  const dbIndex = chatIndex(dbScope);
  const domain_mismatch: ShadowComparisonDetail['domain_mismatch'] = [];
  const type_mismatch: ShadowComparisonDetail['type_mismatch'] = [];
  const person_ref_mismatch: ShadowComparisonDetail['person_ref_mismatch'] = [];

  for (const key of [...staticKeys].filter((k) => dbKeys.has(k)).sort()) {
    const s = staticIndex.get(key);
    const d = dbIndex.get(key);
    if (!s || !d) continue;
    if (s.domain !== d.domain) domain_mismatch.push({ chat: key, static: s.domain, roster: d.domain });
    if (s.conversationType !== d.conversationType) {
      type_mismatch.push({ chat: key, static: s.conversationType, roster: d.conversationType });
    }
    // Compared explicitly: the roster used to emit its row id here while the
    // legacy scope emitted canonical_person_ref, and no bucket covered it, so a
    // real attribution divergence still reported zero differences.
    if (s.canonicalPersonRef !== d.canonicalPersonRef) {
      person_ref_mismatch.push({ chat: key, static: s.canonicalPersonRef, roster: d.canonicalPersonRef });
    }
  }

  const staticPairs = identityPairs(staticScope);
  const dbPairs = identityPairs(dbScope);
  const identity_mismatch: ShadowComparisonDetail['identity_mismatch'] = [];
  for (const pn of new Set([...staticPairs.keys(), ...dbPairs.keys()])) {
    const s = staticPairs.has(pn) ? (staticPairs.get(pn) ?? null) : null;
    const d = dbPairs.has(pn) ? (dbPairs.get(pn) ?? null) : null;
    if (!staticPairs.has(pn) || !dbPairs.has(pn) || s !== d) {
      identity_mismatch.push({ pn, static: s, roster: d });
    }
  }
  identity_mismatch.sort((a, b) => a.pn.localeCompare(b.pn));

  const total =
    missing_in_static.length +
    extra_in_static.length +
    domain_mismatch.length +
    type_mismatch.length +
    person_ref_mismatch.length +
    identity_mismatch.length;

  return {
    total,
    staticCount: staticKeys.size,
    dbCount: dbKeys.size,
    detail: { missing_in_static, extra_in_static, domain_mismatch, type_mismatch, person_ref_mismatch, identity_mismatch },
  };
}

/** Fail-closed configuration validation. Throws instead of silently disabling the safety period. */
export function shadowConfig(): ShadowConfig {
  const rawStart = process.env.ALRIFAI_ROSTER_SHADOW_START?.trim();
  if (!rawStart) throw new Error('ROSTER_SHADOW_CONFIG_INVALID: ALRIFAI_ROSTER_SHADOW_START is missing');
  const started = new Date(rawStart);
  if (!Number.isFinite(started.getTime())) {
    throw new Error('ROSTER_SHADOW_CONFIG_INVALID: ALRIFAI_ROSTER_SHADOW_START is not a valid ISO timestamp');
  }
  const rawHours = process.env.ALRIFAI_ROSTER_SHADOW_DURATION_HOURS?.trim();
  const hours = rawHours ? Number(rawHours) : Number.NaN;
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('ROSTER_SHADOW_DURATION_INVALID: ALRIFAI_ROSTER_SHADOW_DURATION_HOURS must be a positive number of hours');
  }
  return {
    startedAt: started.toISOString(),
    autoPromoteAt: new Date(started.getTime() + hours * 3_600_000).toISOString(),
    durationHours: hours,
  };
}

export function rosterSource(): RosterSource {
  const raw = (process.env.ALRIFAI_ROSTER_SOURCE ?? 'STATIC').trim().toUpperCase();
  if (raw === 'STATIC' || raw === 'SHADOW' || raw === 'DB') return raw;
  throw new Error(`ROSTER_SOURCE_UNKNOWN: ${raw}`);
}

function normalizeShadowRow(row: Record<string, unknown>): RosterShadowState {
  return {
    mode: row.mode === 'DB' ? 'DB' : 'SHADOW',
    cycles_completed: Number(row.cycles_completed ?? 0),
    diffs_found: Number(row.diffs_found ?? 0),
    started_at: toIso(row.started_at),
    auto_promote_at: toIso(row.auto_promote_at),
    auto_promote_blocked: row.auto_promote_blocked === true,
    last_check_at: toIso(row.last_check_at),
    last_diff_detail: (row.last_diff_detail as ShadowComparisonDetail | null) ?? null,
  };
}

/** Reads the singleton row, seeding it from env on the first SHADOW cycle. */
export async function readShadowState(db: Queryable, config: ShadowConfig): Promise<RosterShadowState> {
  const found = await db.query(`SELECT ${SHADOW_COLUMNS} FROM public.roster_shadow_state WHERE singleton = TRUE`);
  if (found.rows.length) return normalizeShadowRow(found.rows[0]);

  await db.query(
    `INSERT INTO public.roster_shadow_state
       (singleton, mode, cycles_completed, diffs_found, started_at, auto_promote_at, auto_promote_blocked, updated_at)
     VALUES (TRUE, 'SHADOW', 0, 0, $1, $2, FALSE, now())
     ON CONFLICT (singleton) DO NOTHING`,
    [config.startedAt, config.autoPromoteAt],
  );

  const seeded = await db.query(`SELECT ${SHADOW_COLUMNS} FROM public.roster_shadow_state WHERE singleton = TRUE`);
  if (!seeded.rows.length) throw new Error('ROSTER_SHADOW_STATE_UNREADABLE: roster_shadow_state has no singleton row');
  return normalizeShadowRow(seeded.rows[0]);
}

/**
 * Atomic cycle write. Counters are incremented in SQL so concurrent readers and a
 * restart cannot lose an increment; no read-modify-write happens in JS.
 */
export async function recordShadowCycle(
  db: Queryable,
  comparison: ShadowComparison,
  mode: ShadowMode,
): Promise<void> {
  await db.query(
    `UPDATE public.roster_shadow_state SET
       mode = $1,
       cycles_completed = cycles_completed + 1,
       diffs_found = diffs_found + $2,
       auto_promote_blocked = auto_promote_blocked OR $3,
       last_check_at = now(),
       last_diff_detail = $4,
       updated_at = now()
     WHERE singleton = TRUE`,
    [mode, comparison.total > 0 ? 1 : 0, comparison.total > 0, JSON.stringify(comparison.detail)],
  );
}

const SHADOW_UPDATABLE = new Set(['mode', 'auto_promote_blocked', 'last_check_at', 'last_diff_detail']);

/** Whitelisted field update, used for diagnostics (never for the atomic cycle counters). */
export async function updateShadowState(
  db: Queryable,
  updates: Partial<Pick<RosterShadowState, 'mode' | 'auto_promote_blocked' | 'last_check_at' | 'last_diff_detail'>>,
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(updates)) {
    if (!SHADOW_UPDATABLE.has(column)) throw new Error(`ROSTER_SHADOW_UPDATE_REJECTED: ${column}`);
    if (value === undefined) continue;
    values.push(column === 'last_diff_detail' && value !== null ? JSON.stringify(value) : value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (!assignments.length) return;
  await db.query(
    `UPDATE public.roster_shadow_state SET ${assignments.join(', ')}, updated_at = now() WHERE singleton = TRUE`,
    values,
  );
}

/** One-way promotion. Reverting requires an explicit DELETE of the singleton row. */
export async function promoteShadowToDB(db: Queryable): Promise<void> {
  await db.query(
    `UPDATE public.roster_shadow_state SET mode = 'DB', updated_at = now() WHERE singleton = TRUE`,
  );
}

let cached: { at: number; scope: ConversationScope; source: Queryable } | undefined;

/**
 * Phase C entry point. Behaviour is selected by ALRIFAI_ROSTER_SOURCE:
 *   STATIC (default) -> legacy tables only, no comparison
 *   DB               -> roster tables only
 *   SHADOW           -> compare both, route with legacy, promote after a clean period
 *
 * In SHADOW the legacy load is fatal if it fails (ingestion stops, fail closed).
 * Only the roster load is caught, because a roster defect must never take down an
 * ingestion cycle that the legacy scope can still serve.
 */
export async function loadConversationScopeWithShadow(db: Queryable): Promise<ConversationScope> {
  const source = rosterSource();
  if (source === 'STATIC') return loadConversationScope(db);
  if (source === 'DB') return loadRosterScope(db);

  // SHADOW: configuration and persistent state are both fail-closed.
  const config = shadowConfig();
  const state = await readShadowState(db, config);
  if (state.mode === 'DB') return loadRosterScope(db);

  // Phase 1: legacy. A failure here is genuinely fatal.
  const staticScope = await loadConversationScope(db);

  // Phase 2: roster. A failure here is recorded and the cycle continues on legacy.
  let dbScope: ConversationScope;
  try {
    dbScope = await loadRosterScope(db);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`ROSTER_SHADOW_COMPARE_ERROR ${reason}`);
    try {
      await updateShadowState(db, { last_check_at: new Date().toISOString() });
    } catch (writeError) {
      console.error(`ROSTER_SHADOW_STATE_WRITE_FAILED ${writeError instanceof Error ? writeError.message : String(writeError)}`);
    }
    return staticScope;
  }

  const comparison = compareScopes(staticScope, dbScope);
  const nowMs = Date.now();
  const dueAt = state.auto_promote_at ? Date.parse(state.auto_promote_at) : Number.NaN;
  const due = Number.isFinite(dueAt) && nowMs >= dueAt;
  const promote = due && comparison.total === 0 && state.diffs_found === 0;
  const nextCycles = state.cycles_completed + 1;

  try {
    await recordShadowCycle(db, comparison, promote ? 'DB' : 'SHADOW');
  } catch (error) {
    console.error(`ROSTER_SHADOW_STATE_WRITE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  }

  // Blocked is a one-time transition, not a per-cycle line.
  if (comparison.total > 0 && !state.auto_promote_blocked) {
    console.error(`ROSTER_AUTO_PROMOTE_BLOCKED: ${comparison.total} diffs found`);
  }

  // Informational line, throttled to one per 10 real minutes.
  if (nowMs - lastShadowLogAt >= SHADOW_LOG_THROTTLE_MS) {
    lastShadowLogAt = nowMs;
    if (comparison.total === 0) {
      const nextCheck = new Date(nowMs + SHADOW_LOG_THROTTLE_MS).toISOString();
      console.log(`ROSTER_SHADOW_OK cycles=${nextCycles} diffs=0 next_check=${nextCheck}`);
    } else {
      console.log(
        `ROSTER_SHADOW_DIFF cycle=${nextCycles} static_count=${comparison.staticCount} db_count=${comparison.dbCount}` +
          ` missing_in_static=${JSON.stringify(comparison.detail.missing_in_static)}` +
          ` extra_in_static=${JSON.stringify(comparison.detail.extra_in_static)}`,
      );
    }
  }

  if (promote) {
    console.log(`ROSTER_AUTO_PROMOTED after ${config.durationHours} hours, 0 diffs`);
    return dbScope;
  }
  return staticScope;
}

/** Cached scope read. The cache is bound to the pool that produced it. */
export async function currentConversationScope(db: Queryable): Promise<ConversationScope> {
  const now = Date.now();
  if (cached && cached.source === db && now - cached.at < CACHE_TTL_MS) return cached.scope;
  const scope = await loadConversationScope(db);
  cached = { at: now, scope, source: db };
  return scope;
}

export function clearConversationScopeCache(): void {
  cached = undefined;
}
