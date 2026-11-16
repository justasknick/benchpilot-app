// webapp/js/resume.js - team resumes (migration 0024, backlog W1). Pure helpers shared by the stores and the Consultant page.
//   * Files live in the private Supabase Storage bucket `team-resumes` at <team_id>/<consultant_id>/<uuid>.<pdf|docx>; the storage policies let
//     only active members of that team read or upload, and only owners/managers delete.
//   * The file check is the extension's own (BP.checkResumeFile in lib/shared.js, BPDocx.isDocx in lib/docx-reader.js; loaded by
//     bp-lib.js loadResumeLib()), so the web app accepts exactly what the extension accepts: PDF or Word .docx, up to 5 MB.
//   * Downloads are signed links that expire after SIGNED_LINK_SECONDS.

export const RESUME_BUCKET = 'team-resumes';
export const RESUME_KEEP = 5;
export const RESUME_MAX_BYTES = 5 * 1024 * 1024;
export const SIGNED_LINK_SECONDS = 60;
export const PDF_TYPE = 'application/pdf';
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const RESUME_ACCEPT = '.pdf,.docx,' + PDF_TYPE + ',' + DOCX_TYPE;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const RESUME_PATH_RE = new RegExp('^' + UUID + '/' + UUID + '/' + UUID + '\\.(pdf|docx)$');

/** <team_id>/<consultant_id>/<uuid>.<ext> (lower case). Throws on anything that would not pass the storage policy. */
export function resumePath(teamId, consultantId, fileId, ext) {
  const p = [teamId, consultantId, fileId].map((x) => String(x || '').toLowerCase()).join('/') + '.' + ext;
  if (!RESUME_PATH_RE.test(p)) throw new Error('Invalid resume path.');
  return p;
}

/**
 * Checks a picked file with the extension's rules. `lib` = { BP, BPDocx } from loadResumeLib().
 * @returns {Promise<{problem:string, kind:'pdf'|'docx'|'', mime:string, ext:string}>}  problem '' = fine
 */
export async function checkResume(file, lib) {
  const BP = lib && lib.BP;
  if (!BP || !BP.checkResumeFile) return { problem: 'The file check could not load. Refresh the page and try again.', kind: '', mime: '', ext: '' };
  let head = '';
  try { head = new TextDecoder('latin1').decode(await file.slice(0, 1024).arrayBuffer()); } catch (e) { head = ''; }
  const kind = BP.resumeKind(head);
  let docxOk = false;
  if (kind === 'docx' && lib.BPDocx) {
    try { docxOk = lib.BPDocx.isDocx(new Uint8Array(await file.arrayBuffer())); } catch (e) { docxOk = false; }
  }
  const problem = BP.checkResumeFile({ name: file.name, type: file.type, size: file.size }, head, { docxOk });
  if (problem) return { problem, kind: '', mime: '', ext: '' };
  return { problem: '', kind, mime: kind === 'docx' ? DOCX_TYPE : PDF_TYPE, ext: kind === 'docx' ? 'docx' : 'pdf' };
}

/** A file name to show: control characters and folders removed, at most 120 characters (the server cleans it again). */
export function cleanFileName(name) {
  const base = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim();
  return base.slice(0, 120) || 'resume';
}

/** "240 KB", "1.2 MB" */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '-';
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (Math.round(n / 104857.6) / 10) + ' MB';
}

/** One consultant_resumes row -> the version shown on the Consultant page. */
export function versionFrom(r) {
  return {
    id: String(r.id), consultantId: String(r.consultant_id || ''), path: String(r.path || ''), fileName: String(r.file_name || ''),
    mime: r.mime === DOCX_TYPE ? DOCX_TYPE : PDF_TYPE, size: Number(r.size_bytes) || 0, uploadedBy: r.uploaded_by || '',
    uploadedAt: String(r.created_at || '')
  };
}

/** The Storage API's error body ({statusCode, error, message}) -> [code, friendly message]. */
export function storageProblem(status, json) {
  const j = json && typeof json === 'object' ? json : {};
  const sc = Number(j.statusCode) || status;
  const msg = String(j.message || j.error || '');
  if (sc === 413 || /maximum allowed size|too large/i.test(msg)) return ['too_large', 'That file is larger than 5 MB.'];
  if (sc === 415 || /mime type/i.test(msg)) return ['invalid', 'Please choose a PDF or Word (.docx) file.'];
  if (sc === 403 || /row-level security|unauthorized/i.test(msg)) {
    return ['forbidden', 'You cannot add files to this consultant. The workspace may be read-only, or you are no longer in this team.'];
  }
  if (sc === 404) return ['not_found', 'That file is no longer there. Refresh the page.'];
  if (sc === 409) return ['duplicate', 'That upload clashed with another one. Please try again.'];
  if (sc >= 500) return ['server', 'Something went wrong on our side. Please try again.'];
  return ['failed', 'The upload did not go through. Please try again.'];
}
