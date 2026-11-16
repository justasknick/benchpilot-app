// lib/jobs.js - "Jobs for you": job openings the user can apply to (a company hiring a recruiter for itself),
// plus the user's own profile used to write the application email. Pure functions only; nothing here
// touches chrome.storage. The service worker (single writer) loads it via importScripts, the dashboard
// and settings page load it as a script, and node tests require it directly.
//
// Storage (written only by the service worker):
//   jobOpenings: [{ id, title, company, contactName, email, phone, location, workMode, postUrl, postText,
//                   headline, savedAt, status, appliedAt, notes, updatedAt }]   max MAX_JOBS
//   myProfile:   { name, title, email, phone, linkedin, summary, resumeFileId }

(function (root) {
  'use strict';

  // Node tests load this file directly; the browser has shared.js loaded before it.
  if (!root.BP && typeof require === 'function') require('./shared.js');
  const BP = root.BP;

  const MAX_JOBS = 500;
  const JOB_STATUSES = ['new', 'applied', 'interview', 'offer', 'rejected', 'closed'];
  const JOB_STATUS_LABELS = { new: 'New', applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', closed: 'Closed' };
  const WORK_MODES = ['remote', 'hybrid', 'onsite'];
  const WORK_MODE_LABELS = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite' };
  const RESUME_OWNER_ID = 'me'; // consultantId used for the user's own resume in lib/resume-store.js

  function clip(value, max) {
    if (value === null || value === undefined) return '';
    return String(value).trim().slice(0, max);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  }

  // '' when missing or invalid, otherwise the lower-cased address.
  function cleanEmail(value) {
    const e = clip(value, 254).toLowerCase();
    return isValidEmail(e) ? e : '';
  }

  function normalizeWorkMode(value) {
    const v = String(value == null ? '' : value).toLowerCase().replace(/[^a-z]/g, '');
    if (v === 'remote') return 'remote';
    if (v === 'hybrid') return 'hybrid';
    if (v === 'onsite' || v === 'inoffice' || v === 'office') return 'onsite';
    return null;
  }

  function normalizeJobStatus(value) {
    const v = String(value == null ? '' : value).toLowerCase();
    return JOB_STATUSES.includes(v) ? v : null;
  }

  // "US IT Recruiter (Remote)" and "us it recruiter" are the same opening.
  function normalizeTitle(title) {
    return String(title == null ? '' : title)
      .toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function normalizePostUrl(url) {
    const u = BP.safeHttpUrl(url);
    if (!u) return '';
    try {
      const p = new URL(u);
      p.hash = '';
      return (p.origin + p.pathname).replace(/\/+$/, '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  // Same email + same normalised title, or the same post URL.
  function dedupeKey(job) {
    const email = cleanEmail(job && job.email);
    const title = normalizeTitle(job && job.title);
    return email && title ? `${email}|${title}` : '';
  }

  function findDuplicate(jobs, candidate) {
    const key = dedupeKey(candidate);
    const url = normalizePostUrl(candidate && candidate.postUrl);
    for (const j of Array.isArray(jobs) ? jobs : []) {
      if (key && dedupeKey(j) === key) return j;
      if (url && normalizePostUrl(j.postUrl) === url) return j;
    }
    return null;
  }

  function newJobId() {
    return BP.newId('j');
  }

  // Validates and clips an incoming job (from the LinkedIn drawer or the "Move to Jobs for you" button).
  // Returns the clean fields without id / status / savedAt (the worker assigns those), or null when
  // there is nothing to save (no title, no email and no post link).
  function sanitizeJobInput(input) {
    const j = input && typeof input === 'object' ? input : {};
    const out = {
      title: clip(j.title, 160),
      company: clip(j.company, 160),
      contactName: clip(j.contactName, 120),
      email: cleanEmail(j.email),
      phone: clip(j.phone, 60),
      location: clip(j.location, 160),
      workMode: normalizeWorkMode(j.workMode),
      postUrl: BP.safeHttpUrl(j.postUrl).slice(0, 1000),
      postText: clip(j.postText, 2000),
      headline: clip(j.headline, 300)
    };
    if (!out.title && !out.email && !out.postUrl) return null;
    if (!out.title) out.title = 'Recruiter role';
    return out;
  }

  function newJob(clean, now) {
    return {
      id: newJobId(),
      ...clean,
      savedAt: now,
      status: 'new',
      appliedAt: null,
      notes: '',
      updatedAt: now
    };
  }

  // appliedAt must be a real date; stored as an ISO string, null when empty or invalid.
  function cleanAppliedAt(value) {
    if (value === null || value === undefined || value === '') return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }

  // Applies the allowed patch fields (status, notes, appliedAt). Status 'applied' sets appliedAt when it is
  // still empty. Returns the updated copy, or { error } for an unknown status.
  function applyJobPatch(job, patch, now) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...job };
    if (p.status !== undefined) {
      const st = normalizeJobStatus(p.status);
      if (!st) return { error: 'Unknown status.' };
      next.status = st;
    }
    if (p.notes !== undefined) next.notes = clip(p.notes, 2000);
    if (p.appliedAt !== undefined) next.appliedAt = cleanAppliedAt(p.appliedAt);
    if (next.status === 'applied' && !next.appliedAt) next.appliedAt = now;
    next.updatedAt = now;
    return { job: next };
  }

  // Keeps at most `max` jobs. When over, the oldest closed / rejected ones go first, then the oldest of the rest.
  function capJobs(jobs, max) {
    const limit = max === undefined ? MAX_JOBS : max;
    const list = Array.isArray(jobs) ? jobs.slice() : [];
    if (list.length <= limit) return list;
    const rank = (j) => (j.status === 'closed' || j.status === 'rejected' ? 0 : 1);
    const order = list.map((j, i) => ({ j, i }))
      .sort((a, b) => rank(a.j) - rank(b.j) || String(a.j.savedAt || '').localeCompare(String(b.j.savedAt || '')) || a.i - b.i);
    const drop = new Set(order.slice(0, list.length - limit).map(x => x.j));
    return list.filter(j => !drop.has(j));
  }

  // ── My profile ───────────────────────────────────────────────────────────
  function sanitizeProfile(input, previous) {
    const p = input && typeof input === 'object' ? input : {};
    const prev = previous && typeof previous === 'object' ? previous : {};
    return {
      name: clip(p.name, 120),
      title: clip(p.title, 160),
      email: cleanEmail(p.email),
      phone: clip(p.phone, 60),
      linkedin: BP.safeHttpUrl(p.linkedin).slice(0, 500),
      summary: clip(p.summary, 1000),
      // Left as it was when the caller does not send it, so an older caller never drops the file reference.
      resumeFileId: 'resumeFileId' in p ? (typeof p.resumeFileId === 'string' ? p.resumeFileId.slice(0, 40) : '') : clip(prev.resumeFileId, 40)
    };
  }

  // Name, title and a way to reach the user are the minimum for an application worth sending.
  function profileComplete(profile) {
    const p = profile || {};
    return Boolean(String(p.name || '').trim() && (String(p.email || '').trim() || String(p.phone || '').trim()));
  }

  // The application email, in the first person, from the job and the user's profile. Empty parts are left out.
  // Returns { to, subject, body }.
  function buildApplyEmail(job, profile) {
    const j = job || {};
    const p = profile || {};
    const name = String(p.name || '').trim();
    const myTitle = String(p.title || '').trim();
    const role = String(j.title || '').trim() || 'recruiter';
    const subject = `Application: ${role}${name ? ' – ' + name : ''}`;

    const first = BP.firstNameOf(j.contactName);
    const greeting = j.contactName && first !== 'there' ? `Hi ${first},` : 'Hello,';
    const lines = [greeting, ''];
    lines.push(`I'd like to apply for the ${role} role${j.company ? ' at ' + j.company : ''}.`);
    const intro = [name ? `I'm ${name}` : '', myTitle ? (name ? `, ${myTitle}` : `I'm a ${myTitle}`) : ''].join('');
    if (intro) lines.push(intro + '.');
    if (p.summary && String(p.summary).trim()) lines.push('', String(p.summary).trim());
    const contact = [];
    if (p.phone && String(p.phone).trim()) contact.push(`Phone: ${String(p.phone).trim()}`);
    if (p.linkedin && String(p.linkedin).trim()) contact.push(`LinkedIn: ${String(p.linkedin).trim()}`);
    if (contact.length) lines.push('', ...contact);
    lines.push('', 'My resume is attached.');
    return { to: cleanEmail(j.email), subject, body: lines.join('\n') };
  }

  // Fields for SAVE_JOB built from a saved lead that is really a job opening (older builds saved these as leads).
  function jobFromLead(lead) {
    const l = lead || {};
    const mode = normalizeWorkMode(l.workMode);
    return {
      title: l.requirement || l.designation || 'Recruiter role',
      company: l.companyName && l.companyName !== 'Staffing Partner' ? l.companyName : '',
      contactName: l.recruiterName || '',
      email: l.email || '',
      phone: l.phone && l.phone !== '—' ? l.phone : '',
      location: l.location || '',
      workMode: mode,
      postUrl: l.sourceUrl || '',
      postText: l.notes || '',
      headline: l.headline || ''
    };
  }

  BP.Jobs = {
    MAX_JOBS, JOB_STATUSES, JOB_STATUS_LABELS, WORK_MODES, WORK_MODE_LABELS, RESUME_OWNER_ID,
    normalizeWorkMode, normalizeJobStatus, normalizeTitle, normalizePostUrl, dedupeKey, findDuplicate,
    sanitizeJobInput, newJob, applyJobPatch, capJobs, sanitizeProfile, profileComplete, buildApplyEmail, jobFromLead,
    isValidEmail, cleanEmail
  };
})(typeof self !== 'undefined' ? self : globalThis);

// Lets node tests load the helpers.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
