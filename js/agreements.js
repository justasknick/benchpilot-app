// webapp/js/agreements.js - vendor agreements in the team workspace (staffing P6, migration 0050). The rules are the extension's own
// BP.Agreements (lib/vendor-agreements.js, loaded by bp-lib.js); this file only adapts them to the web app's lookups.
//   agreementsOrNull()          BP.Agreements, or null when it cannot load (every screen then works without the agreement parts)
//   msaWarningFor(ctx, vendor)  the soft "No signed MSA with <vendor>" line for New submission ('' = nothing to say). Never blocks.
//   agreementReminders(ctx)     MSAs and NDAs that end within 30 days or have ended, soonest first (Today)

import { loadAgreementsLib } from './bp-lib.js';
import { todayISO } from './dates.js';

export async function agreementsOrNull() { try { return await loadAgreementsLib(); } catch (e) { return null; } }

/** Quiet until the team records any agreement, so a team that does not use them sees no warning on every submission. */
export async function msaWarningFor(ctx, vendor) {
  const A = vendor ? await agreementsOrNull() : null;
  return A ? A.msaWarning(vendor.name, vendor, todayISO(), A.tracking(ctx.lk.vendors)) : '';
}

export async function agreementReminders(ctx) {
  const A = await agreementsOrNull();
  return A ? { A, list: A.reminders(ctx.lk.vendors, todayISO()) } : { A: null, list: [] };
}
