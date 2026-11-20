'use strict';

/**
 * The repo the dashboard is scoped to: the tracked repo (lowercased), or ''
 * for "all repos" when nothing is tracked or tracking was turned off.
 * Read on every call so switching repos takes effect immediately.
 */
function currentScope(db, config) {
  const row = db.prepare('SELECT tracked_repo, untracked FROM project_settings WHERE id = 1').get();
  if (row && row.untracked) return '';
  return String((row && row.tracked_repo) || config.repo || '').toLowerCase();
}

// SQL fragment limiting `commits` to the scope. Pass { scope } as the statement's
// first argument (named parameters), followed by any positional ones.
// commits.repo keeps GitHub's casing from webhooks ("Owner/Name"), hence lower().
const IN_SCOPE = "(@scope = '' OR lower(repo) = @scope)";

module.exports = { currentScope, IN_SCOPE };
