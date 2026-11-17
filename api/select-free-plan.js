// POST /api/select-free-plan
// Header: Authorization: Bearer <supabase access token>
// Returns: { ok: true, plan: "beastmode" }
//
// Beastmode (personal budgeting) is free, so there is no Stripe checkout for it. This
// records the person's choice in the same `subscriptions` table the app already reads, so
// the rest of the app treats it like any other plan. It runs server-side with the service
// role key because the table is read-only for users (that's what stops someone from
// granting themselves Business by editing client-side JavaScript) — and this endpoint can
// only ever grant the FREE plan.
//
// It never touches stripe_customer_id / stripe_subscription_id, so a free user who used a
// Business trial in the past is still correctly remembered as having used it.

const { verifyUser, supabaseAdmin } = require('./_lib/verifyUser');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const user = await verifyUser(req);

    const { data: row, error: readError } = await supabaseAdmin
      .from('subscriptions')
      .select('user_id, plan, status')
      .eq('user_id', user.id)
      .maybeSingle();
    if (readError) throw readError;

    // Someone on an active Business plan or trial must change it through billing
    // ("Manage my plan"), so nobody loses paid access or a running trial by accident.
    if (row && row.plan === 'beastmode-business' && (row.status === 'active' || row.status === 'trialing')) {
      res.status(400).json({ error: 'You currently have Beastmode Business. Use "Manage my plan" to cancel it, then you can continue with free Beastmode.' });
      return;
    }

    const now = new Date().toISOString();
    const { error } = row
      ? await supabaseAdmin.from('subscriptions')
          .update({ plan: 'beastmode', status: 'active', current_period_end: null, updated_at: now })
          .eq('user_id', user.id)
      : await supabaseAdmin.from('subscriptions')
          .insert({ user_id: user.id, plan: 'beastmode', status: 'active', updated_at: now });
    if (error) throw error;

    res.status(200).json({ ok: true, plan: 'beastmode' });
  } catch (err) {
    console.error('select-free-plan error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Something went wrong.' });
  }
};
