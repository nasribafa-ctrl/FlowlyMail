/**
 * app/api/gmail/callback/route.ts
 *
 * Reçoit le retour de Google après consentement. Échange le `code` contre
 * les tokens, chiffre le refresh_token (AES-256-GCM), et l'enregistre dans
 * gmail_accounts. n8n ne verra jamais ce refresh_token : il passera par le
 * Token Broker (/api/internal/gmail-token, phase suivante) pour obtenir un
 * access_token de courte durée.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceSupabase } from "@/lib/supabase/service";
import { encrypt, verifyOAuthState } from "@/lib/crypto";

export const runtime = "nodejs";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const NONCE_COOKIE = "gmail_oauth_nonce";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface GmailProfileResponse {
  emailAddress: string;
}

/** Redirige vers le dashboard avec un code d'erreur lisible côté UI. */
function redirectWithError(request: NextRequest, code: string) {
  const url = new URL("/dashboard", request.url);
  url.searchParams.set("gmail_error", code);
  const response = NextResponse.redirect(url);
  response.cookies.delete(NONCE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const requiredEnv = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "OAUTH_STATE_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("Variables d'environnement manquantes:", missing);
    return NextResponse.json(
      { error: "Configuration serveur incomplète" },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  if (googleError) {
    // L'utilisateur a refusé le consentement, ou Google a renvoyé une erreur.
    return redirectWithError(request, `google_${googleError}`);
  }
  if (!code || !state) {
    return redirectWithError(request, "missing_code_or_state");
  }

  // 1. Vérifie la signature du state (protège contre un state falsifié)
  let statePayload;
  try {
    statePayload = verifyOAuthState(state);
  } catch (err) {
    console.error("state OAuth invalide:", err);
    return redirectWithError(request, "invalid_state");
  }

  // 2. Vérifie le nonce (protège contre le rejeu d'un state intercepté)
  const nonceCookie = request.cookies.get(NONCE_COOKIE)?.value;
  if (!nonceCookie || nonceCookie !== statePayload.nonce) {
    return redirectWithError(request, "nonce_mismatch");
  }

  // 3. Vérifie que l'utilisateur courant appartient bien à l'entreprise
  //    encodée dans le state (empêche de connecter Gmail au nom d'une
  //    autre entreprise que la sienne).
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectWithError(request, "not_authenticated");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("entreprise_id")
    .eq("id", user.id)
    .single();

  if (!profile || profile.entreprise_id !== statePayload.entreprise_id) {
    return redirectWithError(request, "entreprise_mismatch");
  }

  // 4. Échange le code contre les tokens
  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    console.error(
      "Échange de code Google échoué:",
      await tokenResponse.text()
    );
    return redirectWithError(request, "token_exchange_failed");
  }

  const tokens = (await tokenResponse.json()) as GoogleTokenResponse;

  if (!tokens.refresh_token) {
    // Ne devrait pas arriver grâce à prompt=consent, mais Google peut
    // parfois omettre le refresh_token (ex. compte déjà autorisé sans
    // révocation préalable). On préfère échouer explicitement plutôt que
    // de stocker un compte inutilisable par le Token Broker.
    return redirectWithError(request, "no_refresh_token");
  }

  // 5. Récupère l'adresse Gmail réellement connectée (ne pas faire
  //    confiance à un email fourni par le client)
  const profileResponse = await fetch(GMAIL_PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileResponse.ok) {
    console.error(
      "Récupération du profil Gmail échouée:",
      await profileResponse.text()
    );
    return redirectWithError(request, "profile_fetch_failed");
  }

  const gmailProfile = (await profileResponse.json()) as GmailProfileResponse;

  // 6. Vérifie qu'aucune autre entreprise n'a déjà connecté cette adresse
  //    Gmail. Un upsert basé sur onConflict("email_surveille") écraserait
  //    silencieusement entreprise_id si on ne faisait pas ce contrôle
  //    explicite en amont — c'est le scénario qu'on veut interdire.
  const service = createServiceSupabase();

  const { data: existingAccount, error: lookupError } = await service
    .from("gmail_accounts")
    .select("id, entreprise_id")
    .eq("email_surveille", gmailProfile.emailAddress)
    .maybeSingle();

  if (lookupError) {
    console.error("Vérification gmail_accounts échouée:", lookupError);
    return redirectWithError(request, "db_lookup_failed");
  }

  if (existingAccount && existingAccount.entreprise_id !== statePayload.entreprise_id) {
    // Tentative de connecter un Gmail déjà rattaché à une autre entreprise.
    // On journalise la tentative (utile pour détecter un abus ou une
    // confusion de compte côté client) sans jamais transférer la propriété.
    await service.from("activity_logs").insert({
      entreprise_id: statePayload.entreprise_id,
      profile_id: user.id,
      actor_type: "user",
      action: "gmail_connect_rejected_already_linked",
      metadata: { email: gmailProfile.emailAddress },
    });
    return redirectWithError(request, "gmail_already_linked_to_another_entreprise");
  }

  // 7. Chiffre et enregistre. On utilise la clé service_role car cet appel
  //    est purement serveur et doit pouvoir écrire indépendamment des
  //    policies RLS conçues pour le dashboard.
  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  const { error: upsertError } = await service.from("gmail_accounts").upsert(
    {
      entreprise_id: statePayload.entreprise_id,
      email_surveille: gmailProfile.emailAddress,
      provider: "gmail",
      refresh_token_encrypted: encrypt(tokens.refresh_token),
      access_token_encrypted: encrypt(tokens.access_token),
      access_token_expires_at: expiresAt,
      scope: tokens.scope,
      status: "active",
      connected_at: new Date().toISOString(),
    },
    { onConflict: "email_surveille" }
  );

  if (upsertError) {
    console.error("Écriture gmail_accounts échouée:", upsertError);
    return redirectWithError(request, "db_write_failed");
  }

  // 8. Trace l'action (sans jamais logger un token)
  await service.from("activity_logs").insert({
    entreprise_id: statePayload.entreprise_id,
    profile_id: user.id,
    actor_type: "user",
    action: "gmail_connected",
    metadata: { email: gmailProfile.emailAddress },
  });

  const response = NextResponse.redirect(
    new URL("/dashboard?gmail=connected", request.url)
  );
  response.cookies.delete(NONCE_COOKIE);
  return response;
}
