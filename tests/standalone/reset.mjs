// Shared integration-test reset. Owner connection is used only for TRUNCATE:
// the runtime role deliberately has no TRUNCATE privilege, and TRUNCATE
// bypasses the row-level immutability triggers on audit/ledger tables.
//
// Only disposable test databases are targeted. Production is never used.
import {createPool} from '../../db/postgres.mjs';

export async function resetBusinessState(applicationName = 'alrifai-test-reset') {
  const owner = createPool({role: 'app', readOnly: false, applicationName});
  try {
    await owner.query(`TRUNCATE TABLE
      audit_events, cash_reversals, cash_reconciliations,
      cash_instructions, cash_postings, ledger_entries,
      cash_submission_reviews, cash_submissions, review_decisions, review_items,
      attendance, identity_aliases, program_pay, program_source_messages,
      program_assignments, program_events, programs, employees,
      escort_client_group_authorizations, rate_config, app_settings
      RESTART IDENTITY`);
  } finally {
    await owner.end();
  }
}
