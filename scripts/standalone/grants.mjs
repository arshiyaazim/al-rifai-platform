// AL-RIFA'I — least-privilege runtime grants.
//
// Shared by the fresh installer and the incremental migration runner so a new
// table cannot be created without also granting the runtime role exactly what
// it needs. Append-only financial/audit tables never receive UPDATE or DELETE.

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const READ_WRITE = [
  'cash_portal_users', 'cash_portal_sessions', 'employees', 'programs',
  'program_assignments', 'attendance', 'program_pay', 'cash_instructions',
  'cash_submissions', 'review_items', 'whatsapp_messages', 'whatsapp_cursors',
  'app_settings', 'schema_meta', 'cash_accounts', 'whatsapp_accounts',
  'whatsapp_chats', 'rate_config',
  // Phase 2 ingestion.
  'whatsapp_import_runs', 'whatsapp_sync_state', 'identity_aliases',
  'whatsapp_media',
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
  // Phase 3 WA-01 Vessel Draft delivery queue (additive, pending approval).
  'vessel_draft_deliveries',
];

const APPEND_ONLY = [
  'cash_portal_audit', 'program_events', 'audit_events',
  'cash_submission_reviews', 'review_decisions', 'cash_postings', 'ledger_entries',
  'cash_reversals', 'ai_messages', 'ai_tool_runs',
];

const DELETE_ONLY = ['cash_portal_sessions', 'login_throttle_state'];

export async function grantRuntime(client, {schema, runtimeUser}) {
  if (!IDENT.test(schema)) throw new Error('INVALID_SCHEMA');
  if (!IDENT.test(runtimeUser)) throw new Error('INVALID_RUNTIME_ROLE');
  await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeUser}"`);
  for (const table of READ_WRITE) {
    await client.query(`GRANT SELECT, INSERT, UPDATE ON "${schema}"."${table}" TO "${runtimeUser}"`);
  }
  for (const table of APPEND_ONLY) {
    await client.query(`GRANT SELECT, INSERT ON "${schema}"."${table}" TO "${runtimeUser}"`);
  }
  for (const table of DELETE_ONLY) {
    await client.query(`GRANT DELETE ON "${schema}"."${table}" TO "${runtimeUser}"`);
  }
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeUser}"`);
  await client.query(`GRANT EXECUTE ON FUNCTION "${schema}".compute_program_pay(text) TO "${runtimeUser}"`);
  await client.query(`GRANT EXECUTE ON FUNCTION "${schema}".normalize_mobile(text) TO "${runtimeUser}"`);
}

export const GRANT_TABLES = {READ_WRITE, APPEND_ONLY, DELETE_ONLY};
