/**
 * app/api/internal/renew-gmail-watches/route.ts
 *
 * Un "watch" Gmail expire au bout de 7 jours maximum (limite Google) —
 * cette route le renouvelle pour tous les comptes dont l'expiration
 * approche. Déclenchée une fois par jour par Vercel Cron (voir
 * vercel.json), jamais par n8n : ça ne consomme aucune exécution n8n.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/service";
import { registerGmailWatch } from "@/lib/gmail-watch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Vercel Cron ajoute automatiquement ce header quand CRON_SECRET est
  // configuré dans les variables d'environnement du projet.
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!process.env.N8N_INTERNAL_SECRET) {
    console.error("Variable d'environnement manquante: N8N_INTERNAL_SECRET");
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const service = createServiceSupabase();

  // Renouvelle tout ce qui expire dans moins de 24h, ou qui n'a jamais eu
  // de watch enregistré (ex. échec silencieux lors de la connexion).
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: accounts, error } = await service
    .from("gmail_accounts")
    .select("id, email_surveille")
    .eq("status", "active")
    .or(`watch_expiration.is.null,watch_expiration.lt.${soon}`);

  if (error) {
    console.error("Lecture gmail_accounts échouée:", error);
    return NextResponse.json({ error: "db_read_failed" }, { status: 500 });
  }

  const results: { email: string; ok: boolean }[] = [];

  for (const account of accounts || []) {
    try {
      // Réutilise le Token Broker existant plutôt que de dupliquer la
      // logique de déchiffrement/rafraîchissement ici.
      const tokenResponse = await fetch(
        `${request.nextUrl.origin}/api/internal/gmail-token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-n8n-secret": process.env.N8N_INTERNAL_SECRET,
          },
          body: JSON.stringify({ gmail_account_id: account.id }),
        }
      );

      if (!tokenResponse.ok) {
        results.push({ email: account.email_surveille, ok: false });
        continue;
      }

      const { access_token } = await tokenResponse.json();
      const watch = await registerGmailWatch(access_token);

      await service
        .from("gmail_accounts")
        .update({
          history_id: watch.historyId,
          watch_expiration: new Date(watch.expirationMs).toISOString(),
        })
        .eq("id", account.id);

      results.push({ email: account.email_surveille, ok: true });
    } catch (err) {
      console.error(`Renouvellement échoué pour ${account.email_surveille}:`, err);
      results.push({ email: account.email_surveille, ok: false });
    }
  }

  return NextResponse.json({ renewed: results });
}
