// webapp/js/demo-data.js - FICTIONAL sample data for the demo workspace.
// Names are first name + initial, companies are invented, emails are @example.com, phones are 555 numbers.
// Dates are written as "days before today" so the demo always looks current and the 90-day guard window is meaningful.

import { addDays } from './dates.js';
import { normalizeVisa } from './consultant-profile.js';

// Staffing P1 sample values: two work authorisations that end soon (so Today shows the reminder card) and two minimum rates. Fictional.
const PROFILE = {
  c1: (f) => ({ workAuthUntil: f(45), rateMin: 65 }),
  c3: (f) => ({ workAuthUntil: f(110) }),
  c5: (f) => ({ workAuthUntil: f(20), rateMin: 480, rateUnit: 'day' })
};

// Staffing P5 sample consent records (fictional): everyone being marketed has one except Neha D. (c6), so Today shows the soft nudge.
const CONSENT = {
  c1: (d) => ({ consentOn: d(38), consentSource: 'email_reply', consentNote: 'Replied "I agree" to the data notice.' }),
  c2: (d) => ({ consentOn: d(16), consentSource: 'signed_form', consentNote: '' }),
  c3: (d) => ({ consentOn: d(24), consentSource: 'email_reply', consentNote: '' }),
  c4: (d) => ({ consentOn: d(8), consentSource: 'verbal_logged', consentNote: 'Agreed on the intake call; notice email sent the same day.' }),
  c5: (d) => ({ consentOn: d(30), consentSource: 'email_reply', consentNote: '' }),
  c7: (d) => ({ consentOn: d(14), consentSource: 'other', consentNote: 'Agreed in the onboarding meeting.' }),
  c8: (d) => ({ consentOn: d(74), consentSource: 'signed_form', consentNote: '' })
};

export const DEMO_TEAM_NAME = 'Northwind Consulting (demo)';

/** Fields that hold ISO days, per collection. Used to move a saved demo forward when a new day starts. */
export const DATE_FIELDS = {
  consultants: ['benchSince', 'availableOn', 'workAuthUntil', 'consentOn'],
  companies: ['createdOn', 'msaSignedOn', 'msaUntil', 'ndaSignedOn', 'ndaUntil'],
  contacts: ['createdOn'],
  requirements: ['postedOn'],
  submissions: ['submittedOn'],
  placements: ['startOn', 'endOn'],
  guardCatches: ['day'],
  invoices: ['periodFrom', 'periodTo', 'issuedOn', 'dueOn', 'sentOn', 'paidOn'],
  invites: ['expiresOn'],
  activity: ['at'],
  inboxAddresses: ['createdAt', 'lastMessageAt'],
  inboxMessages: ['receivedAt', 'createdAt', 'handledAt'],
  team: ['pilotEndsOn']
};
/** Timesheet weeks start on a Monday: shiftState moves them like a day, then back to that week's Monday. */
export const WEEK_FIELDS = { timesheets: ['weekStart'] };
export function mondayOf(day) { const wd = new Date(day + 'T00:00:00Z').getUTCDay(); return addDays(day, wd === 0 ? -6 : 1 - wd); }
/** Fields that hold an instant (ISO timestamp), per collection: moved by whole days like DATE_FIELDS. */
export const TIME_FIELDS = { interviews: ['at'] };

/** Staffing P3 sample interviews and placements (fictional). Interview times are fixed UTC times on demo days (10:30 / 14:00 US Eastern in
 *  winter); s8 is a placement that ends within 30 days, s10 an active one. Pay rates are on the rows (the demo's own pay table). */
export function seedP3(today) {
  const d = (n) => addDays(today, -n);
  const f = (n) => addDays(today, n);
  const at = (day, hm) => day + 'T' + hm + ':00.000Z';
  return {
    interviews: [
      { id: 'iv1', submissionId: 's4', consultantId: 'c3', at: at(d(2), '16:00'), tz: 'America/New_York', round: 1, mode: 'phone', withWhom: 'Rhea P. (vendor screen)', feedback: 'Good on Terraform and AKS. Moved to the client round.', outcome: 'passed', createdBy: 'm4' },
      { id: 'iv2', submissionId: 's4', consultantId: 'c3', at: at(f(0), '15:30'), tz: 'America/New_York', round: 2, mode: 'video', withWhom: 'Hiring manager and a platform lead', feedback: '', outcome: 'pending', createdBy: 'm4' },
      { id: 'iv3', submissionId: 's5', consultantId: 'c5', at: at(f(1), '19:00'), tz: 'America/Chicago', round: 1, mode: 'video', withWhom: 'Panel of two', feedback: '', outcome: 'pending', createdBy: 'm3' }
    ],
    placements: [
      { id: 'pl1', submissionId: 's8', consultantId: 'c8', startOn: d(45), endOn: f(20), billRate: 55, payRate: 45, rateUnit: 'hr', taxTerms: 'W2', endClient: 'Orchard Systems', vendorCompanyId: 'v6', poRef: 'PO-7781', status: 'active', createdBy: 'm3' },
      { id: 'pl2', submissionId: 's10', consultantId: 'c7', startOn: d(14), endOn: f(170), billRate: 78, payRate: 64, rateUnit: 'hr', taxTerms: 'C2C', endClient: 'Lakeside Logistics', vendorCompanyId: 'v3', poRef: 'WO-2026-114', status: 'active', createdBy: 'm4' }
    ]
  };
}

/** Timesheets, invoices and commission rules (0055) for the two sample placements, fictional. pl1 (Orchard Systems, $55/h W2, started 45
 *  days ago): the first two finished weeks on an invoice that is overdue (Net 30 when it was made), the next two on a paid one, the rest
 *  approved and ready to invoice, the last finished week submitted. pl2 (Lakeside, started 14 days ago): its first week approved, the
 *  weeks after it missing (Today's reminder). The firm's invoice details and two commission rules. */
export function seedBilling(today) {
  const thisMonday = mondayOf(today);
  const weeksOf = (start) => { const out = []; for (let w = mondayOf(start); addDays(w, 6) < today && w < thisMonday; w = addDays(w, 7)) out.push(w); return out; };
  const timesheets = [];
  let n = 0;
  const ts = (placementId, weekStart, extra) => { n += 1; timesheets.push({ id: 'ts' + n, placementId, weekStart, regular: 40, ot: 0, approvedBy: 'Dana L. (client manager)', status: 'approved', invoiceId: '', createdBy: placementId === 'pl1' ? 'm3' : 'm4', ...extra }); };
  const w1 = weeksOf(addDays(today, -45));
  w1.forEach((w, i) => {
    if (i === 0) ts('pl1', w, { regular: 24, invoiceId: 'inv1' });                 // started mid-week
    else if (i === 1) ts('pl1', w, { ot: 3, invoiceId: 'inv1' });
    else if (i < 4) ts('pl1', w, { invoiceId: 'inv2' });
    else if (i === w1.length - 1) ts('pl1', w, { regular: 38, approvedBy: '', status: 'submitted' });
    else ts('pl1', w, i === 4 ? { ot: 2 } : {});
  });
  const w2 = weeksOf(addDays(today, -14));
  if (w2.length) ts('pl2', w2[0], { regular: 32, approvedBy: 'Ken M. (delivery lead)', createdBy: 'm4' });
  const sum = (id, k) => timesheets.filter((t) => t.invoiceId === id).reduce((a, t) => a + t[k], 0);
  const end = (id) => addDays(timesheets.filter((t) => t.invoiceId === id).map((t) => t.weekStart).sort().pop(), 6);
  const first = (id) => timesheets.filter((t) => t.invoiceId === id).map((t) => t.weekStart).sort()[0];
  const year = today.slice(0, 4);
  const iss1 = addDays(end('inv1'), 3), iss2 = addDays(end('inv2'), 2);
  const invoices = [
    { id: 'inv1', placementId: 'pl1', number: `NW-${year}-0007`, periodFrom: addDays(today, -45) > first('inv1') ? addDays(today, -45) : first('inv1'), periodTo: end('inv1'),
      regularHours: sum('inv1', 'regular'), otHours: sum('inv1', 'ot'), billRate: 55, otRate: 82.5, currency: 'USD', issuedOn: iss1, netTerms: 30, dueOn: addDays(iss1, 30),
      status: 'sent', sentOn: iss1, paidOn: '', note: 'Net 30 under the old terms.', createdBy: 'm1' },
    { id: 'inv2', placementId: 'pl1', number: `NW-${year}-0008`, periodFrom: first('inv2'), periodTo: end('inv2'),
      regularHours: sum('inv2', 'regular'), otHours: sum('inv2', 'ot'), billRate: 55, otRate: 82.5, currency: 'USD', issuedOn: iss2, netTerms: 60, dueOn: addDays(iss2, 60),
      status: 'paid', sentOn: iss2, paidOn: addDays(today, -2), note: '', createdBy: 'm1' }
  ];
  return {
    timesheets, invoices,
    commissionRules: [
      { id: 'cr1', memberId: '', basis: 'margin_pct', pct: 10, fixed: null, leadMemberId: '', leadSharePct: 0 },
      { id: 'cr2', memberId: 'm4', basis: 'fixed', pct: null, fixed: 500, leadMemberId: 'm2', leadSharePct: 20 }
    ],
    invoiceProfile: { prefix: 'NW-', address: '120 Example Street, Suite 400\nAustin, TX 78701', email: 'accounts@example.com', phone: '555-0142',
      taxId: 'EIN 12-3456789', paymentDetails: 'ACH to Example Bank, account ending 0042, routing 000000000.\nPlease quote the invoice number.' }
  };
}

/** Staffing P4 samples: the team's week and month targets, one person's own, and the guard's catches per person (sample people only). */
export function seedP4(today) {
  const d = (n) => addDays(today, -n);
  return {
    targets: [
      { id: 'tg1', memberId: '', deskId: '', period: 'week', submissions: 20, interviews: 4, placements: 1 },
      { id: 'tg2', memberId: '', deskId: '', period: 'month', submissions: 70, interviews: 14, placements: 3 },
      { id: 'tg3', memberId: 'm3', deskId: '', period: 'week', submissions: 12, interviews: 3, placements: 0 }
    ],
    guardCatches: [{ day: d(1), userId: 'm3', warned: 2 }, { day: d(3), userId: 'm4', warned: 1 }, { day: d(12), userId: 'm3', warned: 1 }]
  };
}

export function buildSeed(today) {
  const d = (n) => addDays(today, -n);
  const f = (n) => addDays(today, n);

  const members = [
    { id: 'm1', name: 'Meera N.', email: 'meera.n@example.com', role: 'owner', joinedOn: d(60) },
    { id: 'm2', name: 'Sam T.', email: 'sam.t@example.com', role: 'manager', joinedOn: d(55) },
    { id: 'm3', name: 'Priya S.', email: 'priya.s@example.com', role: 'recruiter', joinedOn: d(50) },
    { id: 'm4', name: 'Dev R.', email: 'dev.r@example.com', role: 'recruiter', joinedOn: d(44) }
  ];

  const consultants = [
    { id: 'c1', name: 'Ravi K.', title: 'Senior Java Developer', skills: ['Java', 'Spring Boot', 'Kafka', 'AWS'], visa: 'H1B', taxTerms: 'C2C', rate: '$72/hr', location: 'Charlotte, NC', relocation: false, availableOn: d(0), status: 'marketing', ownerRecruiterId: 'm3', benchSince: d(41), notes: 'Strong banking background. Prefers hybrid.' },
    { id: 'c2', name: 'Anita M.', title: 'QA Automation Lead', skills: ['Selenium', 'Cypress', 'Java', 'API testing'], visa: 'GC', taxTerms: 'W2', rate: '$58/hr', location: 'Dallas, TX', relocation: true, availableOn: d(3), status: 'marketing', ownerRecruiterId: 'm3', benchSince: d(18), notes: '' },
    { id: 'c3', name: 'Kiran P.', title: 'DevOps Engineer', skills: ['Kubernetes', 'Terraform', 'Azure', 'CI/CD'], visa: 'H1B', taxTerms: 'C2C', rate: '$68/hr', location: 'Atlanta, GA', relocation: true, availableOn: f(7), status: 'interviewing', ownerRecruiterId: 'm4', benchSince: d(26), notes: 'Second round next week.' },
    { id: 'c4', name: 'Sara L.', title: 'Data Engineer', skills: ['Python', 'Spark', 'Snowflake', 'Airflow'], visa: 'USC', taxTerms: 'W2', rate: '$64/hr', location: 'Remote', relocation: false, availableOn: d(0), status: 'marketing', ownerRecruiterId: 'm4', benchSince: d(9), notes: '' },
    { id: 'c5', name: 'Vikram J.', title: '.NET Full Stack Developer', skills: ['.NET', 'C#', 'Angular', 'SQL Server'], visa: 'H4 EAD', taxTerms: 'C2C', rate: '$60/hr', location: 'Chicago, IL', relocation: false, availableOn: d(0), status: 'interviewing', ownerRecruiterId: 'm3', benchSince: d(33), notes: '' },
    { id: 'c6', name: 'Neha D.', title: 'Salesforce Developer', skills: ['Salesforce', 'Apex', 'LWC'], visa: 'GC', taxTerms: '1099', rate: '$62/hr', location: 'Austin, TX', relocation: true, availableOn: d(0), status: 'marketing', ownerRecruiterId: 'm4', benchSince: d(52), notes: 'Long on the bench. Needs a fresh pitch.' },
    { id: 'c7', name: 'Omar H.', title: 'Site Reliability Engineer', skills: ['Go', 'Prometheus', 'AWS'], visa: 'USC', taxTerms: 'W2', rate: '$70/hr', location: 'Seattle, WA', relocation: false, availableOn: f(170), status: 'placed', ownerRecruiterId: 'm4', benchSince: d(44), notes: 'Placed at Lakeside Logistics through Northbay.' },
    { id: 'c8', name: 'Lina G.', title: 'Business Analyst', skills: ['Agile', 'SQL', 'Jira'], visa: 'GC', taxTerms: 'W2', rate: '$55/hr', location: 'Boston, MA', relocation: false, availableOn: d(30), status: 'placed', ownerRecruiterId: 'm3', benchSince: d(75), notes: 'Placed with Orchard Systems.' }
  ].map((c) => ({ resumeName: '', visaType: normalizeVisa(c.visa), workAuthUntil: '', rateMin: null, rateUnit: 'hr', ...(PROFILE[c.id] ? PROFILE[c.id](f) : {}),
    consentOn: '', consentSource: '', consentNote: '', erased: false, ...(CONSENT[c.id] ? CONSENT[c.id](d) : {}), ...c }));

  const companies = [
    { id: 'v1', name: 'Brightpath Staffing', domain: 'brightpath.example', tier: 'tier1', avoidReason: '', notes: 'Quick to respond. Mostly banking and insurance.', doNotContact: false, createdOn: d(58) },
    { id: 'v2', name: 'Northbay Staffing', domain: 'northbay.example', tier: 'prime', avoidReason: '', notes: 'Prime vendor for Brightfield Bank.', doNotContact: false, createdOn: d(57) },
    { id: 'v3', name: 'Cedar Ridge Consulting', domain: 'cedarridge.example', tier: 'tier2', avoidReason: '', notes: '', doNotContact: false, createdOn: d(40) },
    { id: 'v4', name: 'Lakeview Talent', domain: 'lakeview.example', tier: 'tier1', avoidReason: '', notes: 'Energy and utilities.', doNotContact: false, createdOn: d(33) },
    { id: 'v5', name: 'Harborline Partners', domain: 'harborline.example', tier: 'tier2', avoidReason: '', notes: '', doNotContact: false, createdOn: d(21) },
    { id: 'v6', name: 'Orchard Systems', domain: 'orchard.example', tier: 'direct_client', avoidReason: '', notes: 'Hires directly. Placed Lina G. here.', doNotContact: false, createdOn: d(45) },
    { id: 'v7', name: 'Quickfill Solutions', domain: 'quickfill.example', tier: 'avoid', avoidReason: 'Slow to pay and asks for rate cuts after submission.', notes: '', doNotContact: false, createdOn: d(30) },
    { id: 'v8', name: 'Summit Resource Group', domain: 'summitrg.example', tier: 'prime', avoidReason: '', notes: '', doNotContact: false, createdOn: d(2) }
  ];
  // Vendor agreements (staffing P6): status and dates only, invented. One MSA ends within 30 days, one NDA has ended, one MSA is only sent.
  const NO_AGREEMENT = { msaStatus: 'none', msaSignedOn: '', msaUntil: '', ndaStatus: 'none', ndaSignedOn: '', ndaUntil: '', netTerms: null, paymentNote: '' };
  const agreements = {
    v1: { msaStatus: 'signed', msaSignedOn: d(340), msaUntil: f(21), ndaStatus: 'signed', ndaSignedOn: d(340), netTerms: 45, paymentNote: 'Invoice by the 5th; pays by bank transfer.' },
    v2: { msaStatus: 'signed', msaSignedOn: d(200), ndaStatus: 'signed', ndaSignedOn: d(200), ndaUntil: d(4), netTerms: 30 },
    v4: { msaStatus: 'sent', ndaStatus: 'signed', ndaSignedOn: d(30) },
    v6: { msaStatus: 'signed', msaSignedOn: d(45), msaUntil: f(320), netTerms: 60 }
  };
  for (const c of companies) Object.assign(c, NO_AGREEMENT, agreements[c.id] || {});

  const contacts = [
    { id: 'ct1', companyId: 'v1', name: 'Dana L.', email: 'dana.l@example.com', phone: '555-0101', title: 'Senior Recruiter', source: 'extension', doNotContact: false, createdOn: d(58), createdBy: 'm3' },
    { id: 'ct2', companyId: 'v1', name: 'Marcus B.', email: 'marcus.b@example.com', phone: '555-0102', title: 'Account Manager', source: 'import', doNotContact: false, createdOn: d(58), createdBy: 'm2' },
    { id: 'ct3', companyId: 'v2', name: 'Elena F.', email: 'elena.f@example.com', phone: '555-0103', title: 'Technical Recruiter', source: 'extension', doNotContact: false, createdOn: d(57), createdBy: 'm3' },
    { id: 'ct4', companyId: 'v2', name: 'Tom W.', email: 'tom.w@example.com', phone: '555-0104', title: 'Delivery Manager', source: 'import', doNotContact: false, createdOn: d(57), createdBy: 'm2' },
    { id: 'ct5', companyId: 'v3', name: 'Ines R.', email: 'ines.r@example.com', phone: '555-0105', title: 'Recruiter', source: 'extension', doNotContact: false, createdOn: d(40), createdBy: 'm4' },
    { id: 'ct6', companyId: 'v4', name: 'Hugo P.', email: 'hugo.p@example.com', phone: '555-0106', title: 'Talent Partner', source: 'extension', doNotContact: false, createdOn: d(33), createdBy: 'm4' },
    { id: 'ct7', companyId: 'v4', name: 'Grace O.', email: 'grace.o@example.com', phone: '555-0107', title: 'Recruiter', source: 'manual', doNotContact: false, createdOn: d(33), createdBy: 'm4' },
    { id: 'ct8', companyId: 'v5', name: 'Leo K.', email: 'leo.k@example.com', phone: '555-0108', title: 'Sourcer', source: 'extension', doNotContact: false, createdOn: d(21), createdBy: 'm3' },
    { id: 'ct9', companyId: 'v6', name: 'Nadia S.', email: 'nadia.s@example.com', phone: '555-0109', title: 'Hiring Manager', source: 'manual', doNotContact: false, createdOn: d(45), createdBy: 'm2' },
    { id: 'ct10', companyId: 'v7', name: 'Rick D.', email: 'rick.d@example.com', phone: '555-0110', title: 'Recruiter', source: 'import', doNotContact: true, createdOn: d(30), createdBy: 'm2' },
    { id: 'ct11', companyId: 'v8', name: 'Alma V.', email: 'alma.v@example.com', phone: '555-0111', title: 'Senior Recruiter', source: 'extension', doNotContact: false, createdOn: d(2), createdBy: 'm4' },
    { id: 'ct12', companyId: 'v8', name: 'Jon M.', email: 'jon.m@example.com', phone: '555-0112', title: 'Recruiter', source: 'extension', doNotContact: false, createdOn: d(1), createdBy: 'm4' }
  ];

  const requirements = [
    { id: 'r1', title: 'Senior Java Developer', endClient: 'Brightfield Bank', jobRef: 'BF-2291', vendorCompanyId: 'v2', vendorContactId: 'ct3', rateText: '$70-75/hr C2C', workMode: 'hybrid', location: 'Charlotte, NC', visaText: 'H1B, GC, USC', taxTerms: 'C2C', duration: '12 months', skills: ['Java', 'Spring Boot', 'Kafka'], source: 'extension', sourceUrl: '', postedOn: d(14), rawText: '', status: 'open', createdBy: 'm3' },
    { id: 'r2', title: 'QA Automation Engineer', endClient: 'Harbor Health', jobRef: 'HH-118', vendorCompanyId: 'v1', vendorContactId: 'ct1', rateText: '$55-60/hr W2', workMode: 'remote', location: 'Remote', visaText: 'GC, USC', taxTerms: 'W2', duration: '6 months', skills: ['Selenium', 'Cypress'], source: 'extension', sourceUrl: '', postedOn: d(4), rawText: '', status: 'open', createdBy: 'm3' },
    { id: 'r3', title: 'Data Engineer', endClient: 'Cobalt Energy', jobRef: '', vendorCompanyId: 'v4', vendorContactId: 'ct6', rateText: '$62-66/hr', workMode: 'onsite', location: 'Houston, TX', visaText: 'USC, GC', taxTerms: 'W2', duration: '9 months', skills: ['Python', 'Spark', 'Snowflake'], source: 'paste', sourceUrl: '', postedOn: d(3), rawText: '', status: 'open', createdBy: 'm4' },
    { id: 'r4', title: 'DevOps Engineer', endClient: 'Meridian Insurance', jobRef: 'MI-5530', vendorCompanyId: 'v3', vendorContactId: 'ct5', rateText: '$65-70/hr C2C', workMode: 'hybrid', location: 'Hartford, CT', visaText: 'H1B, GC', taxTerms: 'C2C', duration: '12 months', skills: ['Kubernetes', 'Terraform'], source: 'extension', sourceUrl: '', postedOn: d(2), rawText: '', status: 'open', createdBy: 'm4' },
    { id: 'r5', title: 'Salesforce Developer', endClient: '', jobRef: '', vendorCompanyId: 'v8', vendorContactId: 'ct11', rateText: '$60/hr', workMode: 'remote', location: 'Remote', visaText: 'Any', taxTerms: '1099', duration: '6 months', skills: ['Salesforce', 'Apex'], source: 'extension', sourceUrl: '', postedOn: d(1), rawText: '', status: 'open', createdBy: 'm4' },
    { id: 'r6', title: '.NET Developer', endClient: 'Atlas Retail', jobRef: 'AR-77', vendorCompanyId: 'v5', vendorContactId: 'ct8', rateText: '$58/hr', workMode: 'onsite', location: 'Chicago, IL', visaText: 'USC', taxTerms: 'W2', duration: '12 months', skills: ['.NET', 'C#'], source: 'import', sourceUrl: '', postedOn: d(40), rawText: '', status: 'closed', createdBy: 'm2' },
    // The same role from a second vendor, two days after r1: Requirements and Matches show "Same role from 2 vendors".
    { id: 'r7', title: 'Sr. Java Developer (Hybrid)', endClient: 'BrightField Bank, Inc.', jobRef: '', vendorCompanyId: 'v1', vendorContactId: 'ct2', rateText: '$68-72/hr', workMode: 'hybrid', location: 'Charlotte, NC', visaText: 'GC, USC', taxTerms: 'C2C/W2', duration: '1 year', skills: ['Java', 'Spring Boot', 'Microservices'], source: 'paste', sourceUrl: '', postedOn: d(12), rawText: '', status: 'open', createdBy: 'm4' }
  ];

  // P2 (0046): a signed RTR has its day (two days before the submission), a 30-day end and the bill rate; pay is $10 below the bill rate.
  const sub = (id, consultantId, requirementId, vendorCompanyId, vendorContactId, endClient, jobRef, rate, rtrStatus, stage, ago, recruiterId, p2) => {
    const bill = Number(String(rate).replace(/[^0-9.]/g, '')) || null;
    const signed = rtrStatus === 'signed';
    return {
      id, consultantId, requirementId, vendorCompanyId, vendorContactId, endClient, jobRef, rate, rtrStatus, stage,
      submittedOn: d(ago), recruiterId, overrideReason: '',
      rtrOn: signed ? d(ago + 2) : '', rtrUntil: signed ? d(ago - 28) : '', rtrRate: signed ? bill : null,
      billRate: bill, rateUnit: 'hr', taxTerms: 'C2C', chain: [], payRate: bill ? bill - 10 : null, ...(p2 || {})
    };
  };
  const submissions = [
    // The guard demo: Ravi K. already went to Brightfield Bank, 12 days ago (28 Oct when today is 9 Nov).
    sub('s1', 'c1', 'r1', 'v2', 'ct3', 'Brightfield Bank', 'BF-2291', '$72/hr', 'requested', 'vendor_screen', 12, 'm3'),
    sub('s2', 'c2', 'r2', 'v1', 'ct1', 'Harbor Health', 'HH-118', '$58/hr', 'none', 'submitted', 1, 'm3'),
    sub('s3', 'c4', 'r3', 'v4', 'ct6', 'Cobalt Energy', '', '$64/hr', 'none', 'submitted', 1, 'm4'),
    sub('s4', 'c3', null, 'v8', 'ct11', 'Brightfield Bank', '', '$68/hr', 'signed', 'client_interview', 3, 'm4', { chain: ['Apex Prime Vendor', 'Infosys'] }),
    // Rate changed after the RTR: the screen warns "Rate differs from the RTR rate: get a new RTR".
    sub('s5', 'c5', 'r4', 'v3', 'ct5', 'Meridian Insurance', 'MI-5530', '$60/hr', 'signed', 'client_interview', 2, 'm3', { rtrRate: 56, chain: ['Northbay Prime'] }),
    sub('s6', 'c6', null, 'v6', 'ct9', 'Orchard Systems', '', '$62/hr', 'none', 'rejected', 20, 'm4'),
    // Outside the 90-day window: does not trigger the guard.
    sub('s7', 'c1', null, 'v5', 'ct8', 'Atlas Retail', 'AR-77', '$70/hr', 'none', 'no_response', 110, 'm3'),
    sub('s8', 'c8', null, 'v6', 'ct9', 'Orchard Systems', '', '$55/hr', 'signed', 'placed', 45, 'm3'),   // its RTR has ended (an expired example)
    sub('s9', 'c2', null, 'v4', 'ct7', 'Cobalt Energy', '', '$58/hr', 'requested', 'vendor_screen', 5, 'm3'),
    // P3: placed two weeks ago (Placements shows it as active).
    sub('s10', 'c7', null, 'v3', 'ct5', 'Lakeside Logistics', 'LL-310', '$78/hr', 'signed', 'placed', 30, 'm4', { billRate: 78, payRate: 64, rtrRate: 78 })
  ];

  const invites = [
    { id: 'i1', email: 'new.recruiter@example.com', role: 'recruiter', invitedBy: 'm1', expiresOn: f(5) }
  ];

  // Staffing P5: the contact log, typed by a person (fictional). `at` is a full time; the demo moves it with the days (store.js shiftState).
  const at = (days, hhmm) => d(days) + 'T' + hhmm + ':00.000Z';
  const contactNotes = [
    { id: 'cn1', entity: 'consultant', entityId: 'c1', kind: 'call', at: at(1, '15:30'), body: 'Checked in about the Brightfield Bank screen. Free for interviews Tue-Thu after 11 am ET.', createdBy: 'm3', createdAt: at(1, '15:42') },
    { id: 'cn2', entity: 'consultant', entityId: 'c1', kind: 'whatsapp', at: at(4, '10:05'), body: 'Sent the updated resume with the Kafka project on top. He confirmed the rate floor of $65/hr.', createdBy: 'm3', createdAt: at(4, '10:07') },
    { id: 'cn3', entity: 'vendor_contact', entityId: 'ct1', kind: 'call', at: at(2, '14:00'), body: 'Dana has two Java roles opening next week at a regional bank. Asked for profiles by Friday, Ravi K. first.', createdBy: 'm3', createdAt: at(2, '14:10') },
    { id: 'cn4', entity: 'vendor_contact', entityId: 'ct1', kind: 'meeting', at: at(9, '16:00'), body: 'Quarterly catch-up. They prefer C2C and pay net 30.', createdBy: 'm2', createdAt: at(9, '16:45') }
  ];

  const activity = [
    { id: 'a1', at: d(12), actor: 'm3', action: 'submission_created', entity: 'submission', entityId: 's1', note: '' },
    { id: 'a2', at: d(2), actor: 'm4', action: 'vendor_added', entity: 'vendor_company', entityId: 'v8', note: '' }
  ];

  // The team inbox (docs/specs/TEAM_INBOX_SPEC.md section 6): one address and two sample emails, one requirement and one
  // Gmail forwarding confirmation. The address domain is a sample; the token is fixed so the demo always shows the same address.
  const inboxAddresses = [
    { id: 'ia1', token: 'k7m2p9x4q8w3', label: 'Vendor mail', createdAt: d(6), disabledAt: '', messageCount: 2, lastMessageAt: d(0), droppedCount: 0, lastDroppedAt: '' }
  ];
  const inboxMessages = [
    {
      id: 'im1', addressId: 'ia1', fromEmail: 'forwarding-noreply@example.com', fromName: 'Gmail Team',
      subject: '(#284716395) Gmail Forwarding Confirmation - Receive Mail from meera.n@example.com', receivedAt: d(0), createdAt: d(0),
      bodyText: 'meera.n@example.com has requested to forward mail to your email address.\n\nConfirmation code: 284716395\n\n' +
        'To allow meera.n@example.com to forward mail to your address, please click the link below to confirm the request:\n\n' +
        'https://mail-settings.google.com/mail/vf-%5BSAMPLE%5D-demo-link\n\n(This is a sample. In the demo the link does not open.)',
      truncated: false, kind: 'forwarding_confirmation', status: 'new', requirementId: '', handledBy: '', handledAt: ''
    },
    {
      id: 'im2', addressId: 'ia1', fromEmail: 'chloe.w@example.com', fromName: 'Chloe W.',
      subject: 'Requirement: Senior Python Developer - Remote - C2C', receivedAt: d(0), createdAt: d(0),
      bodyText: 'Hi,\n\nPlease share profiles for the role below.\n\nTitle: Senior Python Developer\nEnd Client: Riverstone Mutual\n' +
        'Location: Remote\nRate: $65-70/hr C2C\nDuration: 6 months\nJob ID: RM-4410\nVisa: H1B, GC, USC\n' +
        'Skills: Python, Django, AWS, PostgreSQL\n\nThanks,\nChloe W.\nTechnical Recruiter, Westgate Talent\nchloe.w@example.com | 555-0121',
      truncated: false, kind: 'mail', status: 'new', requirementId: '', handledBy: '', handledAt: ''
    }
  ];

  return {
    version: 1,
    seededOn: today,
    seq: 100,
    session: { signedIn: false, role: 'owner' },
    team: {
      id: 't1', name: DEMO_TEAM_NAME, plan: 'pilot', pilotEndsOn: f(2), pilotExtensionRequested: false,   // a sample pilot on day 12 of 14
      settings: { exportPolicy: { manager: true, recruiter: false }, payPolicy: { recruiter: false }, reportTime: '08:00', timeZone: 'America/New_York', reportManagers: false, reportWeekday: 1, leaderboardPolicy: { others: true } },
      inboxDomain: 'in.example.com', inboxLimit: 1
    },
    members, consultants, companies, contacts, requirements, submissions, invites, activity, inboxAddresses, inboxMessages, contactNotes,
    ...seedP3(today),
    ...seedP4(today),
    ...seedBilling(today)
  };
}

/** The demo user for each role in the role switcher. */
export const DEMO_USER_BY_ROLE = { owner: 'm1', manager: 'm2', recruiter: 'm3' };
