// webapp/js/feedback.js - "Send feedback" in the web app's footer: POST /functions/v1/feedback (supabase/functions/_shared/feedback.js).
// The web app shares its origin with the website, and the feedback function accepts from that origin only an anonymous idea: kind 'idea',
// no Authorization header, no screenshot. So nothing ties the message to the account; the person can add their email in the text.
// Context is the function's whitelist only: page (path, no query or hash), surface, language, user agent, time. Never data from the book.

import { h, clear } from './dom.js';
import { button, note } from './ui.js';

export const FEEDBACK_MIN = 5;
export const FEEDBACK_MAX = 2000;

/** The request body the function expects. */
export function feedbackBody(message, env) {
  const e = env || {};
  return {
    kind: 'idea',
    message: String(message || '').trim().slice(0, FEEDBACK_MAX),
    context: { surface: 'webapp', page: String(e.page || '').replace(/[?#].*$/, '').slice(0, 300), lang: String(e.lang || '').slice(0, 20),
      ua: String(e.ua || '').slice(0, 200), at: String(e.at || '') }
  };
}

/** Sends one message. Throws an Error with a short, friendly message. */
export async function sendFeedback({ fetch, config, message, env }) {
  const text = String(message || '').trim();
  if (text.length < FEEDBACK_MIN) throw new Error('Write a few words first.');
  if (text.length > FEEDBACK_MAX) throw new Error('Please keep it under ' + FEEDBACK_MAX + ' characters.');
  let res;
  try {
    res = await fetch(String(config.SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/feedback', {
      method: 'POST', headers: { apikey: config.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(feedbackBody(text, env))
    });
  } catch (e) { throw new Error('No connection. Check your internet and try again.'); }
  if (res.ok) return true;
  if (res.status === 429) throw new Error('Too many messages for now. Please try again in an hour.');
  if (res.status >= 500) throw new Error('Something went wrong on our side. Please try again.');
  throw new Error('That did not go through. Please try again.');
}

/** The footer with its small form (opens in place). */
export function feedbackFooter({ fetch, config, toast }) {
  const box = h('div', { class: 'feedback-box', hidden: true });
  const ta = h('textarea', { rows: 4, maxlength: String(FEEDBACK_MAX), id: 'feedback-text', 'aria-describedby': 'feedback-hint' });
  const msg = h('div', { 'aria-live': 'polite' });
  const send = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field wide' }, h('label', { for: 'feedback-text' }, 'What should we fix or add?'), ta,
      h('span', { class: 'hint', id: 'feedback-hint' }, 'Sent without your name or email. Add your email if you want a reply. Do not paste recruiters\' contact details.')),
    msg, h('div', { class: 'row-end' }, button('Close', { variant: 'ghost', onclick: () => { box.hidden = true; } }), send));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg); send.disabled = true;
    try {
      await sendFeedback({ fetch, config, message: ta.value, env: { page: location.pathname, lang: navigator.language, ua: navigator.userAgent, at: new Date().toISOString() } });
      ta.value = ''; box.hidden = true; toast('Thank you. Your feedback was sent.');
    } catch (err) { msg.append(note('danger', err.message)); }
    send.disabled = false;
  });
  box.append(form);
  const open = button('Send feedback', { variant: 'link', onclick: () => { box.hidden = !box.hidden; if (!box.hidden) ta.focus(); } });
  return h('footer', { class: 'site-footer' }, open, box);
}
