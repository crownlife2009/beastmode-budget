// POST /api/create-checkout-session
// Body: { "plan": "beastmode" | "beastmode-business", "trial": true|false }
// Header: Authorization: Bearer <supabase access token>
// Returns: { url: "https://checkout.stripe.com/..." } — redirect the browser there.
//
// This is the ONLY place your Stripe secret key is used. It never touches the browser.
//
// Trial behavior: the Starter plan is a 30-day free trial that gives full Beastmode
// Business access and then converts to the regular Beastmode plan ($9.99/mo). The trial
// checkout is created on the BEASTMODE ($9.99) price with a 30-day Stripe trial attached,
// so when the trial ends Stripe's very first invoice is already $9.99 - there is no
// "swap the price afterward" step that could race the first charge. The app itself
// (see the subscription check in beastmode-budget.html) gives every 'trialing'
// subscription full Business access, so the trial still feels like Business.

const Stripe = require('stripe');
const { verifyUser, supabaseAdmin } = require('./_lib/verifyUser');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// EDIT: map your plan names to the Stripe Price IDs you create in the Stripe Dashboard
// (Product catalog → add a recurring price for each plan, then copy its "price_..." id).
const PRICE_IDS = {
  'beastmode': process.env.STRIPE_PRICE_BEASTMODE,
  'beastmode-business': process.env.STRIPE_PRICE_BEASTMODE_BUSINESS,
};
const TRIAL_DAYS = 30;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const user = await verifyUser(req);

    const { plan, trial } = req.body || {};
    // A trial is always on the Beastmode ($9.99) price, whichever plan button the request
    // named, so it converts to Beastmode when the 30 days end. Business access during the
    // trial is granted by the app, not by the price.
    const priceId = trial ? PRICE_IDS['beastmode'] : PRICE_IDS[plan];
    if (!priceId) {
      res.status(400).json({ error: `Unknown plan "${plan}".` });
      return;
    }

    // Reuse an existing Stripe customer for this user if we already have one on file,
    // so someone switching plans (or resubscribing) doesn't end up as duplicate customers.
    const { data: existingRow } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('user_id', user.id)
      .maybeSingle();

    // A person only gets one free trial, ever. Without this, someone whose trial
    // already ended (converted to paid, or was canceled) could keep clicking
    // "Start Free Trial" and get another 30 free days indefinitely. Checking this
    // here — not just hiding the button client-side — is what actually enforces it,
    // since a client-side-only check can always be bypassed.
    const alreadyHadSubscription = !!(existingRow && existingRow.stripe_subscription_id);
    if (trial && alreadyHadSubscription) {
      res.status(400).json({ error: "Looks like you've already used your free trial — pick Beastmode or Beastmode Business to continue." });
      return;
    }

    let customerId = existingRow && existingRow.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
    }

    // Prefer the PUBLIC_SITE_URL env var; fall back to the known production domain
    // (NOT req.headers.host — that reflects whatever URL the browser happened to be
    // on, e.g. the *.vercel.app preview domain, which is how this redirect bug happens).
    const siteUrl = process.env.PUBLIC_SITE_URL || 'https://www.beastmodebudget.com';

    const subscriptionData = {
      metadata: {
        supabase_user_id: user.id,
        starter_trial: trial ? 'true' : 'false',
      },
    };
    if (trial) subscriptionData.trial_period_days = TRIAL_DAYS;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/?checkout=success`,
      cancel_url: `${siteUrl}/?checkout=canceled`,
      subscription_data: subscriptionData,
      allow_promotion_codes: true,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Something went wrong.' });
  }
};
