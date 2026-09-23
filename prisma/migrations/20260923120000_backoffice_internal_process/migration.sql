CREATE TABLE IF NOT EXISTS ticket_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id text NOT NULL,
  from_operator_id text,
  to_operator_id text,
  actor_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_assignment_events_ticket_created_idx
  ON ticket_assignment_events (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_assignment_events_actor_idx
  ON ticket_assignment_events (actor_id);

CREATE TABLE IF NOT EXISTS sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  priority text NOT NULL,
  category text,
  first_response_minutes integer NOT NULL,
  resolution_minutes integer NOT NULL,
  business_hours boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sla_policies_unique_active_scope_idx
  ON sla_policies (priority, COALESCE(category, ''), active);

CREATE TABLE IF NOT EXISTS ticket_sla_snapshots (
  ticket_id text PRIMARY KEY,
  priority text NOT NULL,
  category text,
  status text NOT NULL,
  assignee_id text,
  created_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL,
  last_message_kind text,
  due_first_response_at timestamptz,
  due_resolution_at timestamptz,
  first_operator_reply_at timestamptz,
  resolved_at timestamptz,
  escalated_at timestamptz,
  escalated_to text,
  escalated_acknowledged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_sla_snapshots_status_idx
  ON ticket_sla_snapshots (status);
CREATE INDEX IF NOT EXISTS ticket_sla_snapshots_assignee_idx
  ON ticket_sla_snapshots (assignee_id);
CREATE INDEX IF NOT EXISTS ticket_sla_snapshots_first_due_idx
  ON ticket_sla_snapshots (due_first_response_at);
CREATE INDEX IF NOT EXISTS ticket_sla_snapshots_resolution_due_idx
  ON ticket_sla_snapshots (due_resolution_at);

CREATE TABLE IF NOT EXISTS internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  visibility_permission text,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS internal_notes_subject_idx
  ON internal_notes (subject_type, subject_id, created_at);
CREATE INDEX IF NOT EXISTS internal_notes_author_idx
  ON internal_notes (author_id);

CREATE TABLE IF NOT EXISTS operator_preferences (
  operator_id text PRIMARY KEY,
  last_workspace text,
  sidebar_collapsed boolean NOT NULL DEFAULT false,
  density text NOT NULL DEFAULT 'comfortable',
  timezone text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id text NOT NULL,
  screen text NOT NULL,
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort jsonb,
  is_default boolean NOT NULL DEFAULT false,
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_views_operator_screen_idx
  ON saved_views (operator_id, screen);
CREATE INDEX IF NOT EXISTS saved_views_screen_shared_idx
  ON saved_views (screen, shared);

CREATE TABLE IF NOT EXISTS alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  threshold text NOT NULL,
  channel text NOT NULL,
  target text NOT NULL,
  required_permission text NOT NULL,
  quiet_hours jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_rules_source_active_idx
  ON alert_rules (source, active);

CREATE TABLE IF NOT EXISTS alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  source text NOT NULL,
  severity text NOT NULL,
  payload jsonb,
  acknowledged_by text,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_events_rule_ack_idx
  ON alert_events (rule_id, acknowledged_at);
CREATE INDEX IF NOT EXISTS alert_events_source_created_idx
  ON alert_events (source, created_at);

CREATE TABLE IF NOT EXISTS contract_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_lead_id text NOT NULL,
  terms jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  draft_document_key text,
  signature_provider text,
  envelope_id text,
  envelope_status text,
  contract_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_drafts_sales_lead_idx
  ON contract_drafts (sales_lead_id);
CREATE INDEX IF NOT EXISTS contract_drafts_status_idx
  ON contract_drafts (status);

CREATE TABLE IF NOT EXISTS backoffice_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backoffice_audit_logs_actor_created_idx
  ON backoffice_audit_logs (actor_id, created_at);
CREATE INDEX IF NOT EXISTS backoffice_audit_logs_subject_idx
  ON backoffice_audit_logs (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS backoffice_audit_logs_action_created_idx
  ON backoffice_audit_logs (action, created_at);
