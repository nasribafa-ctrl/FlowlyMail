/**
 * lib/gmail-watch.ts
 *
 * Enregistre ou renouvelle un "watch" Gmail : ça demande à Google de
 * PRÉVENIR notre app (via Google Pub/Sub) quand un nouveau mail arrive,
 * au lieu que n8n aille vérifier toutes les minutes que ce soit utile ou
 * non. C'est ce qui remplace le Schedule Trigger de l'Orchestrateur.
 *
 * Un watch expire au bout de 7 jours maximum (limite imposée par Google) —
 * il faut donc le renouveler périodiquement (voir
 * app/api/internal/renew-gmail-watches/route.ts).
 */

const GMAIL_WATCH_URL = "https://gmail.googleapis.com/gmail/v1/users/me/watch";

export interface GmailWatchResult {
  historyId: string;
  /** Timestamp d'expiration, en millisecondes depuis epoch (fourni par Google). */
  expirationMs: number;
}

export async function registerGmailWatch(accessToken: string): Promise<GmailWatchResult> {
  const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!topicName) {
    throw new Error("GOOGLE_PUBSUB_TOPIC manquant dans les variables d'environnement");
  }

  const response = await fetch(GMAIL_WATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      topicName,
      labelIds: ["INBOX"],
      labelFilterAction: "include",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Échec de l'enregistrement du watch Gmail: ${detail}`);
  }

  const data = (await response.json()) as { historyId: string; expiration: string };
  return {
    historyId: data.historyId,
    expirationMs: Number(data.expiration),
  };
}
