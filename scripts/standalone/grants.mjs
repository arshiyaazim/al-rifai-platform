// AL-RIFA'I — least-privilege runtime grants.
//
// Shared by the fresh installer and the incremental migration runner so a new
// table cannot be created without also granting the runtime role exactly what
// it needs. Append-only financial/audit tables never receive UPDATE or DELETE.

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const READ_WRITE = [
  'cash_portal_users', 'cash_portal_sessions', 'employees', 'programs',
  'program_assignments', 'attendance', 'attendance_records', 'program_pay', 'cash_instructions',
  'cash_submissions', 'review_items', 'whatsapp_messages', 'whatsapp_cursors',
  'app_settings', 'schema_meta', 'cash_accounts', 'whatsapp_accounts',
  'whatsapp_chats', 'rate_config',
  // Phase 2 ingestion.
  'whatsapp_import_runs', 'whatsapp_sync_state', 'identity_aliases',
  'whatsapp_media',
  // Message intelligence / call trace (migration 012)
  'whatsapp_calls', 'whatsapp_message_intelligence',
  // Phase 3 router / vessel correlation / authorization.
  'program_source_messages', 'escort_client_group_authorizations',
  'login_throttle_state',
  // Phase 3 Cash lifecycle: a reconciliation row is updated when it is closed.
  'cash_reconciliations',
  // Phase 3 AI communication foundation
  'ai_contacts', 'ai_admin_jids', 'ai_conversations', 'ai_applicant_drafts',
  'ai_job_catalog', 'ai_outbound_messages', 'ai_escalations', 'ai_order_drafts',
  // Send attempts are written SENDING and closed to a terminal state.
  'ai_outbound_attempts',
// Phase 3 WA-01 Vessel Draft delivery queue (migration 010, transport inert).
  'vessel_draft_deliveries',
  // Phase 2 vessel overhaul (migration 018).
  'system_feature_flags', 'message_review_queue', 'message_pipeline_state',
  'vessel_backlog_progress',
  // Phase 3 vessel reference directory (migration 020).
  'vessels',
  // Phase 4E AI key registry + recruitment audit (migrations 025/026).
  'api_keys', 'recruitment_reply_log',
];

const APPEND_ONLY = [
  'cash_portal_audit', 'program_events', 'audit_events',
  'cash_submission_reviews', 'review_decisions', 'cash_postings', 'ledger_entries',
  'cash_reversals', 'ai_messages', 'ai_tool_runs',
  // Business Paid Events are append-only. Corrections/reversals are new rows;
  // the posting link is also append-only once postInstruction() commits.
  'cash_payment_events', 'cash_payment_event_postings',
  'cash_transaction_adjustments',
];

const DELETE_ONLY = ['cash_portal_sessions', 'login_throttle_state'];

// Read-only projections. Never grant INSERT/UPDATE through a view.
const READ_ONLY_VIEWS = ['whatsapp_message_intelligence_view'];

export async function grantRuntime(client, {schema, runtimeUser}) {
  if (!IDENT.test(schema)) throw new Error('INVALID_SCHEMA');
  if (!IDENT.test(runtimeUser)) throw new Error('INVALID_RUNTIME_ROLE');
  await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeUser}"`);
  const grant = async (table, privileges) => {
    const present = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`${schema}.${table}`]);
    if (present.rows[0]?.present === true) {
      await client.query(`GRANT ${privileges} ON "${schema}"."${table}" TO "${runtimeUser}"`);
    }
  };
  for (const table of READ_WRITE) await grant(table, 'SELECT, INSERT, UPDATE');
  for (const table of APPEND_ONLY) await grant(table, 'SELECT, INSERT');
  for (const table of DELETE_ONLY) await grant(table, 'DELETE');
  for (const view of READ_ONLY_VIEWS) await grant(view, 'SELECT');
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeUser}"`);
  // Function grants are guarded the same way as table grants: the baseline
  // installer stops at migration 017, so functions introduced by later additive
  // layers (019+) are absent on a fresh install and must not abort it.
  const grantFunction = async (signature) => {
    const present = await client.query('SELECT to_regprocedure($1) IS NOT NULL AS present', [`${schema}.${signature}`]);
    if (present.rows[0]?.present === true) {
      await client.query(`GRANT EXECUTE ON FUNCTION "${schema}".${signature} TO "${runtimeUser}"`);
    }
  };
  for (const signature of [
    'compute_program_pay(text)',
    'normalize_mobile(text)',
    'normalize_vessel_name(text)',
    'reset_daily_api_usage()',
  ]) await grantFunction(signature);
}

export const GRANT_TABLES = {READ_WRITE, APPEND_ONLY, DELETE_ONLY, READ_ONLY_VIEWS};
