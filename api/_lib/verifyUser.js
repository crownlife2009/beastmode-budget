// Shared helper used by every API route that needs to know WHO is calling it.
//
// Never trust a user ID sent in the request body — anyone can edit client-side JS and
// send any ID they want. Instead, the frontend sends the Supabase access token it got
// from signing in (a signed JWT), and we ask Supabase to verify it server-side. Only
// then do we know the request truly came from that user.

const { createClient } = require('@supabase/supabase-js');

// Uses the service role key, which is allowed to verify tokens and bypass Row Level
// Security. This key must ONLY ever be used in server code (like this file) — never
// send it to the browser.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Reads the "Authorization: Bearer <token>" header from a request, verifies it with
 * Supabase, and returns the authenticated user. Throws if missing/invalid.
 */
async function verifyUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    const err = new Error('Not signed in.');
    err.statusCode = 401;
    throw err;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data || !data.user) {
    const err = new Error('Your session has expired — please sign in again.');
    err.statusCode = 401;
    throw err;
  }

  return data.user; // { id, email, ... }
}

module.exports = { verifyUser, supabaseAdmin };
