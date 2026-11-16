// webapp/js/delete-ui.js - the Delete button for a team-book record: shown to owners and managers only (record-delete.js), asks first,
// then runs the store's delete. Recruiters never see it; a read-only workspace shows nothing either.

import { button } from './ui.js';
import { canDeleteRecords, deleteConfirmText } from './record-delete.js';

/**
 * @param ctx  the screen context (session.role, readOnly, toast)
 * @param {{kind:string, name:string, extra?:number, label?:string, run:()=>Promise<any>, done:()=>void, blocked?:string}} o
 *   blocked = why it cannot be deleted now (shown as the button's title; the button is disabled)
 */
export function deleteButton(ctx, o) {
  if (!canDeleteRecords(ctx.session.role, !ctx.readOnly)) return null;
  return button(o.label || 'Delete', {
    variant: 'danger-ghost', 'aria-label': 'Delete ' + o.name, disabled: Boolean(o.blocked), title: o.blocked || null,
    onclick: async (e) => {
      const btn = e.currentTarget;
      if (!confirm(deleteConfirmText(o.kind, o.name, o.extra))) return;
      btn.disabled = true;
      try { await o.run(); ctx.toast('Deleted.'); o.done(); } catch (err) { ctx.toast(err.message); btn.disabled = false; }
    }
  });
}
