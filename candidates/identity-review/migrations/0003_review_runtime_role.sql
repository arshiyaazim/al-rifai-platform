-- Disposable qualification only. Production role/migration authorization is separate.
-- alrifai_app is existing owner; never change owner privileges or credentials.
CREATE ROLE ir_review_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ir_review_runtime;
GRANT USAGE ON SCHEMA public,identity_review_candidate TO ir_review_runtime;
GRANT SELECT,INSERT,UPDATE ON public.programs TO ir_review_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON identity_review_candidate.records TO ir_review_runtime;
-- Immutable triggers still reject historical record UPDATE/DELETE. No schema/DDL/role/finance grants.
-- Trusted identity/staff provisioning uses a separate approved operator, never runtime DML.
ALTER TABLE identity_review_candidate.records ENABLE ROW LEVEL SECURITY;
CREATE POLICY ir_read ON identity_review_candidate.records FOR SELECT TO ir_review_runtime USING (true);
CREATE POLICY ir_insert ON identity_review_candidate.records FOR INSERT TO ir_review_runtime WITH CHECK (collection NOT IN ('registry','registryHistory','staff'));
CREATE POLICY ir_update ON identity_review_candidate.records FOR UPDATE TO ir_review_runtime USING (collection NOT IN ('registry','registryHistory','staff')) WITH CHECK (collection NOT IN ('registry','registryHistory','staff'));
CREATE POLICY ir_delete ON identity_review_candidate.records FOR DELETE TO ir_review_runtime USING (collection NOT IN ('registry','registryHistory','staff'));

ALTER ROLE ir_review_runtime SET search_path TO public;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT SELECT ON identity_review_candidate.operator_decisions TO ir_review_runtime;
