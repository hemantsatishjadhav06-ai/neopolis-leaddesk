// In-memory fake sheet for local testing (SHEETS_PROVIDER=memory). Mirrors the real leads tab layout.
export const HEADERS = ['id', 'created_time', 'campaign_name', 'form_name', 'platform',
  'what_is_your_primary_objective_for_exploring_a_property?', 'how_soon_do_you_want_to_buy?',
  'which_high-growth_corridor_are_you_primarily_interested_in?', 'what_unit_size/configuration_fits_your_requirement?',
  'how_do_you_plan_to_fund_this_purchase?', 'what_is_your_comfortable_upfront_down-payment?',
  'email', 'full_name', ' ', 'whatsapp_number', 'lead_status', 'feedback ', 'phone_number'];

const seed = [
  ['l:1', '2026-08-06T19:31:58+05:30', 'Land owner units campaign', '02-08-2026', 'ig', 'investment_(rental_yield_&_capital_appreciation)', 'by_2027', 'financial_district_/_nanakramguda', 'luxury_3.5_/_4_bhk_(2,800_–_4,000_sq._ft.)', '100%_self-funded_/_cash', '4cr_and_above_', 'asha@example.com', 'Asha Rao', 'p:+919000000002', '+919000000002', 'CREATED', '', ''],
  ['l:2', '2026-08-06T21:20:28+05:30', 'Land owner units campaign', '02-08-2026', 'fb', 'buying_for_personal_use_/_dream_home', 'ready_to_move-in', 'tellapur_/_kollur_(high_appreciation_belt)', 'premium_3_bhk_(1,800_–_2,500_sq._ft.)', 'home_loan', '1cr_to_1.2cr_', 'ravi@example.com', 'Ravi Menon', 'p:+919000000003', '+919000000003', 'CREATED', '', ''],
  ['l:3', '2026-08-07T09:02:10+05:30', 'Land owner units campaign', '02-08-2026', 'fb', 'buying_for_personal_use_/_dream_home', 'within_6_months', 'kokapet_/_neopolis', 'premium_3_bhk_(1,800_–_2,500_sq._ft.)', 'home_loan', '2cr_to_2.5cr_', 'arjun@example.com', 'Arjun Reddy', 'p:+919000000001', '+919000000001', 'CREATED', '', ''],
  ['l:4', '2026-08-07T11:45:00+05:30', 'Land owner units campaign', '02-08-2026', 'ig', 'investment_(rental_yield_&_capital_appreciation)', 'by_2027', 'narsingi_/_manchirevula', 'compact_2_bhk', 'home_loan', 'below_1cr', 'meera@example.com', 'Meera Iyer', 'p:+9109000000044', '+9109000000044', '', '', ''],
  ['l:5', '2026-08-08T08:15:00+05:30', 'Land owner units campaign', '02-08-2026', 'fb', 'buying_for_personal_use_/_dream_home', 'ready_to_move-in', 'kokapet_/_neopolis', 'luxury_3.5_/_4_bhk_(2,800_–_4,000_sq._ft.)', '100%_self-funded_/_cash', '3cr_to_3.5cr_', 'sameer@example.com', 'Sameer Khan', '', '9000000005', 'CREATED', '', ''],
];

// Any other firm gets a plain contact list (Name / Number), the shape of a bulk-message sheet. Asha is also
// firm 1's lead: the same person can be a lead of both firms.
const CONTACTS = { headers: ['Name', 'Number'], rows: [['Kiran Shah', '9000000101'], ['Asha Rao', '+91 90000 00002'], ['Wrong Number', '12345'], ['Divya Nair', '090000 00103']] };

export function createMemoryProvider(firmId = 1) {
  const state = Number(firmId) === 1
    ? { headers: [...HEADERS], rows: seed.map(r => [...r]), replies: [], tab: '02-08-2026' }
    : { headers: [...CONTACTS.headers], rows: CONTACTS.rows.map(r => [...r]), replies: [], tab: 'Sheet1' };
  return {
    name: 'memory',
    state,
    ping: async () => ({ ok: true, name: `${state.tab} (in-memory test sheet)`, tabs: [state.tab, 'Client Replies'] }),
    readLeads: async () => ({ tab: state.tab, headers: [...state.headers], rows: state.rows.map((values, i) => ({ rowNumber: i + 2, values: state.headers.map((_, j) => values[j] ?? '') })) }),
    updateRow: async (rowNumber, values) => {
      const row = state.rows[rowNumber - 2]; if (!row) throw new Error('row not found');
      for (const [k, v] of Object.entries(values)) {
        let idx = state.headers.findIndex(h => h.trim().toLowerCase() === k.trim().toLowerCase());
        if (idx < 0) { state.headers.push(k); idx = state.headers.length - 1; }
        row[idx] = v;
      }
      return { ok: true };
    },
    appendReply: async (row) => { state.replies.push(row); return { ok: true }; },
  };
}
