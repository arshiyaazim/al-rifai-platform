-- Runner-compatible candidate proposal. Operator execution only; no live migration performed.
CREATE FUNCTION identity_review_candidate.protect_program_command_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_ledger jsonb; new_ledger jsonb; n integer;
BEGIN
 old_ledger=OLD.details::jsonb->'programCommand';
 IF old_ledger IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROGRAM_COMMAND_HISTORY_IMMUTABLE'; END IF;
 new_ledger=NEW.details::jsonb->'programCommand';
 IF new_ledger IS NULL OR new_ledger->'scope' IS DISTINCT FROM old_ledger->'scope'
  OR new_ledger->'authority' IS DISTINCT FROM old_ledger->'authority'
  OR new_ledger->'schemaVersion' IS DISTINCT FROM old_ledger->'schemaVersion'
  OR new_ledger->'allocation' IS DISTINCT FROM old_ledger->'allocation'
  OR (old_ledger->>'primaryReviewId' IS NOT NULL AND new_ledger->'primaryReviewId' IS DISTINCT FROM old_ledger->'primaryReviewId')
  OR NEW.revision<>OLD.revision+1
  OR jsonb_array_length(new_ledger->'events')<>jsonb_array_length(old_ledger->'events')+1 THEN
  RAISE EXCEPTION 'PROGRAM_COMMAND_HISTORY_IMMUTABLE';
 END IF;
 FOR n IN 0..jsonb_array_length(old_ledger->'events')-1 LOOP
  IF new_ledger->'events'->n IS DISTINCT FROM old_ledger->'events'->n THEN RAISE EXCEPTION 'PROGRAM_COMMAND_HISTORY_IMMUTABLE'; END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER program_command_history BEFORE UPDATE OR DELETE ON public.programs FOR EACH ROW EXECUTE FUNCTION identity_review_candidate.protect_program_command_history();
