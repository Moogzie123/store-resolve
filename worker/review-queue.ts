// Review-queue SQL. Column aliases map the real mail_processing_runs columns
// (model_name, prompt_version, ai_structured_output_json, disagreement_flags_json)
// onto the interpretation_* names the frontend expects. Keep these in sync with
// worker/mail-interpretation.ts persistence: interpretation output is stored in
// ai_structured_output_json, and confidence is extracted from its JSON body.
// A regression test (tests/review-queue-api.test.ts) runs both queries against
// the real migration schema — every column referenced here must exist there.
export const REVIEW_QUEUE_LIST_QUERY = `
  SELECT ri.id, ri.status, ri.reason_code, ri.disagreement_flags_json, ri.created_at,
         ms.subject, ms.sender_address, ms.received_at, ms.provider_message_id,
         json_extract(pr.ai_structured_output_json, '$.confidence') AS interpretation_confidence,
         pr.disagreement_flags_json AS interpretation_disagreements_json,
         pr.model_name AS interpretation_model, pr.prompt_version AS interpretation_prompt_version
  FROM mail_review_items ri
  JOIN mail_source_messages ms ON ms.id = ri.source_message_id
  LEFT JOIN mail_processing_runs pr ON pr.id = ri.processing_run_id
  WHERE ri.status='OPEN'
  ORDER BY ri.created_at DESC
  LIMIT 100
`

export const REVIEW_QUEUE_DETAIL_QUERY = `
  SELECT ri.*, ms.subject, ms.sender_address, ms.received_at, ms.provider_message_id,
         ms.conversation_id, ms.internet_message_id,
         pr.model_name AS interpretation_model, pr.prompt_version AS interpretation_prompt_version,
         pr.ai_structured_output_json AS interpretation_json,
         json_extract(pr.ai_structured_output_json, '$.confidence') AS interpretation_confidence,
         pr.disagreement_flags_json AS interpretation_disagreements_json,
         pr.normalized_output_json,
         pr.deterministic_evidence_json, pr.status AS run_status
  FROM mail_review_items ri
  JOIN mail_source_messages ms ON ms.id = ri.source_message_id
  LEFT JOIN mail_processing_runs pr ON pr.id = ri.processing_run_id
  WHERE ri.id=?
`
