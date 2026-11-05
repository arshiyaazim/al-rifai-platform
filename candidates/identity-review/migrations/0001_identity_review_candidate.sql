-- Runner-compatible candidate proposal. Operator execution only; no live migration performed.
CREATE SCHEMA identity_review_candidate;
CREATE TABLE identity_review_candidate.records (
 collection text NOT NULL CHECK (collection IN ('meta','registry','registryHistory','staff','sessions','attempts','occurrences','sourceRevisions','reviews','reviewHistory','audit','observations','progress','operations','nativeReceipts','nativeBindings','identityClaims','claimHistory','nativeSuppression')),
 id text NOT NULL CHECK (length(id) BETWEEN 1 AND 500),
 payload jsonb NOT NULL,
 PRIMARY KEY(collection,id)
);
CREATE FUNCTION identity_review_candidate.prevent_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.collection IN ('audit','registryHistory','reviewHistory','sourceRevisions','nativeReceipts','claimHistory','operations') THEN
  RAISE EXCEPTION 'APPEND_ONLY_HISTORY_REQUIRED';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON identity_review_candidate.records
 FOR EACH ROW EXECUTE FUNCTION identity_review_candidate.prevent_history_mutation();

CREATE TABLE identity_review_candidate.operator_decisions(id text PRIMARY KEY,pin text NOT NULL,purpose text NOT NULL CHECK(purpose='CLAIM_VERIFY'),revoked boolean NOT NULL DEFAULT false);
