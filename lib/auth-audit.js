'use strict';

function buildAuthAuditRow(params) {
  params = params || {};
  const payload = Object.assign({
    endpoint: params.endpoint || null,
    eventType: params.eventType || null
  }, params.metadata || {});

  if (params.targetPlayerId != null && params.targetPlayerId !== '') {
    payload.target_player_id = String(params.targetPlayerId);
  }

  return {
    event_type: params.eventType,
    actor_id: params.actorId != null ? String(params.actorId) : null,
    club_id: params.clubId != null ? String(params.clubId) : null,
    ticket_id: params.ticketId || null,
    payload
  };
}

async function persistRequiredAuthAudit(sb, params) {
  if (!sb) {
    const missing = new Error('required_audit_unavailable');
    missing.code = 'required_audit_unavailable';
    throw missing;
  }
  if (!params || !params.eventType || !params.actorId || !params.clubId) {
    const invalid = new Error('required_audit_context_missing');
    invalid.code = 'required_audit_context_missing';
    throw invalid;
  }

  let result;
  try {
    result = await sb.from('audit_events').insert(buildAuthAuditRow(params));
  } catch (_) {
    const thrown = new Error('required_audit_persistence_failed');
    thrown.code = 'required_audit_persistence_failed';
    throw thrown;
  }
  if (!result || result.error) {
    const failed = new Error('required_audit_persistence_failed');
    failed.code = 'required_audit_persistence_failed';
    throw failed;
  }
  return { ok: true };
}

module.exports = {
  buildAuthAuditRow,
  persistRequiredAuthAudit
};
