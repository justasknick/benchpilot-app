// webapp/js/route.js - the hash router's parser (pure, so tests can load it without a browser).
//   #today  #bench  #consultant-<id>  #requirements  #matches?by=consultant  #inbox?show=new  #vendors?company=<id>  #submissions  #placements  #reports  #timesheets?placement=<id>  #invoices?status=overdue|print=<id>  #commission  #import  #team  #audit  #templates   signed-in screens
//   #book  #book-<section>   My book (Solo personal workspace; record ids are never put in the address)
//   #signin  #accept                                                                              before a team exists

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const [path, query] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  const b = /^book(?:-([a-z]+))?$/.exec(path);
  if (b) return { name: 'book', section: b[1] || '', id: '', params };
  const m = /^consultant-(.+)$/.exec(path);
  if (m) return { name: 'consultant', id: m[1], params };
  return { name: path || 'today', id: '', params };
}
