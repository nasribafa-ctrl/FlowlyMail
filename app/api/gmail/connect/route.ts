/**
 * app/api/gmail/connect/route.ts
 *
 * Point de départ du flux "Connecter Gmail". Redirige l'utilisateur vers
 * l'écran de consentement Google. n8n n'intervient jamais ici : seule
 * l'app Next.js parle à Google.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createOAuthState } from "@/lib/crypto";

// Nécessaire : ce fichier utilise le module Node `crypto`, indisponible
// dans le runtime Edge.
export const runtime = "nodejs";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// Scopes minimaux : lecture, envoi, brouillons, gestion des libellés/lecture.
// On évite volontairement le scope complet "https://mail.google.com/".
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ");

const NONCE_COOKIE = "gmail_oauth_nonce";
const NONCE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes, largement suffisant

export async function GET(request: NextRequest) {
  const requiredEnv = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_REDIRECT_URI",
    "OAUTH_STATE_SECRET",
  ];
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("Variables d'environnement manquantes:", missing);
    return NextResponse.json(
      { error: "Configuration serveur incomplète" },
      { status: 500 }
    );
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", "/dashboard");
    return NextResponse.redirect(loginUrl);
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("entreprise_id")
    .eq("id", user.id)
    .single();

  if (profileError || !profile?.entreprise_id) {
    // Pas encore d'entreprise associée : l'utilisateur doit terminer
    // l'onboarding avant de pouvoir connecter Gmail.
    return NextResponse.redirect(new URL("/onboarding", request.url));
  }

  const { state, nonce } = createOAuthState(profile.entreprise_id);

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    access_type: "offline", // requis pour obtenir un refresh_token
    prompt: "consent", // force le renvoi d'un refresh_token à chaque connexion
    include_granted_scopes: "true",
    scope: GMAIL_SCOPES,
    state,
  });

  const response = NextResponse.redirect(
    `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
  );

  // Le nonce est vérifié côté callback pour empêcher qu'un state volé
  // (ex. intercepté dans une URL loggée) soit rejouable depuis un autre
  // navigateur/session.
  response.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: NONCE_MAX_AGE_SECONDS,
    path: "/",
  });

  return response;
}
