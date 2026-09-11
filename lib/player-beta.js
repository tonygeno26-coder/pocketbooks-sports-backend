'use strict';

// Open player beta: one discoverable club, no public club creation.
// Pure decisions only — callers perform DB writes.

const BETA_CLUB_ID = 'd616dc2a-95a6-473a-97b1-7da330878479';

const ACTIVE_STATUSES = { approved: 1, active: 1 };
const TERMINAL_STATUSES = {
  pending: 1,
  rejected: 1,
  denied: 1,
  suspended: 1,
  inactive: 1,
  removed: 1
};

function publicClubCreationEnabled(flag) {
  return flag === true;
}

function isDiscoverableClubId(id) {
  return String(id || '') === BETA_CLUB_ID;
}

function assignedSignupRole(requestedRole, email, masterAdminEmail) {
  // Client-supplied role is never honored. Host/admin cannot be self-assigned.
  if (masterAdminEmail && email &&
      String(email).toLowerCase() === String(masterAdminEmail).toLowerCase()) {
    return 'master_admin';
  }
  return 'user';
}

function publicClubCard(row) {
  if (!row || !isDiscoverableClubId(row.id)) return null;
  return {
    id: String(row.id),
    name: row.name || 'PocketBooks Beta',
    description: row.description || '',
    is_locked: !!row.is_locked,
    is_active: row.active !== false && row.is_active !== false
  };
}

function membershipView(row) {
  if (!row) return null;
  return {
    status: String(row.status || '').toLowerCase(),
    role: String(row.role || 'player').toLowerCase()
  };
}

function createClubDenial(flagEnabled) {
  if (publicClubCreationEnabled(flagEnabled)) return null;
  return {
    http: 403,
    body: {
      ok: false,
      error: 'club_creation_disabled',
      message: 'Club creation is coming later.'
    }
  };
}

function _normStatus(status) {
  return String(status || '').toLowerCase().trim();
}

// Join uses the existing membership row. Never inserts a second row.
// Open club → approved player membership. Locked club → pending request.
// Non-beta clubs are indistinguishable from missing clubs (no enumeration).
function resolveJoin(opts) {
  const requestedClubId = opts && opts.requestedClubId;
  if (requestedClubId && String(requestedClubId) !== BETA_CLUB_ID) {
    return { http: 404, body: { ok: false, error: 'club_not_found' } };
  }
  const found = !!(opts && opts.clubFound);
  const foundId = opts && opts.foundClubId;
  if (!found || !isDiscoverableClubId(foundId)) {
    return { http: 404, body: { ok: false, error: 'club_not_found' } };
  }

  const existing = _normStatus(opts.existingStatus);
  if (existing) {
    if (ACTIVE_STATUSES[existing] || TERMINAL_STATUSES[existing]) {
      return {
        http: 200,
        already: true,
        insert: null,
        status: existing === 'active' ? 'active' : existing,
        role: String(opts.existingRole || 'player').toLowerCase()
      };
    }
    // Unknown existing status: do not insert a duplicate row.
    return {
      http: 200,
      already: true,
      insert: null,
      status: existing,
      role: String(opts.existingRole || 'player').toLowerCase()
    };
  }

  const locked = !!opts.isLocked;
  const status = locked ? 'pending' : 'approved';
  return {
    http: 200,
    already: false,
    insert: { role: 'player', status: status },
    status: status,
    role: 'player'
  };
}

function joinResponse(decision, clubRow) {
  const card = publicClubCard(clubRow) || {
    id: BETA_CLUB_ID,
    name: 'PocketBooks Beta',
    description: '',
    is_locked: false,
    is_active: true
  };
  return {
    ok: true,
    success: true,
    already: !!decision.already,
    status: decision.status,
    role: decision.role || 'player',
    membership: { status: decision.status, role: decision.role || 'player' },
    club: card
  };
}

module.exports = {
  BETA_CLUB_ID,
  publicClubCreationEnabled,
  isDiscoverableClubId,
  assignedSignupRole,
  publicClubCard,
  membershipView,
  createClubDenial,
  resolveJoin,
  joinResponse
};
