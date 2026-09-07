// POST /api/create-portal-session
// Header: Authorization: Bearer <supabase access token>
// Returns: { url: "https://billing.stripe.com/..." } — redirect the browser there.
//
// Sends the signed-in user to Stripe's hosted portal, where they can update their
// payment method, change plans, view invoices, or cancel — no custom UI needed.

const Stripe = require('stripe');
const { verifyUser, supabaseAdmin } = require('./_lib/verifyUser');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const user = await verifyUser(req);

    const { data: row, error } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error || !row || !row.stripe_customer_id) {
      res.status(404).json({ error: "We don't have a billing account for you yet — subscribe to a plan first." });
      return;
    }

    const siteUrl = process.env.PUBLIC_SITE_URL || `https://${req.headers.host}`;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${siteUrl}/`,
    });

    res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error('create-portal-session error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Something went wrong.' });
  }
};
