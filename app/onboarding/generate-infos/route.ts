/**
 * app/api/onboarding/generate-infos/route.ts
 *
 * Reçoit l'URL du site d'un client, récupère son contenu, et demande à
 * Claude de le résumer en une description métier exploitable par l'agent
 * IA de FlowlyMail (horaires, services, tarifs...). Le client relit et
 * corrige le résultat avant de valider — ce texte n'est jamais enregistré
 * automatiquement sans validation humaine.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_PAGE_TEXT_CHARS = 6000;
const FETCH_TIMEOUT_MS = 10000;

function stripHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  return withoutTags.replace(/\s+/g, " ").trim();
}

function normalizeUrl(input: string): string | null {
  try {
    const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const url = new URL(withProtocol);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Variable d'environnement manquante: ANTHROPIC_API_KEY");
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // Nécessite d'être connecté (on ne veut pas exposer cet endpoint publiquement,
  // il consomme des appels API payants).
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const rawUrl = body?.url?.trim();
  if (!rawUrl) {
    return NextResponse.json({ error: "url_required" }, { status: 400 });
  }

  const url = normalizeUrl(rawUrl);
  if (!url) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  let pageText: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const pageResponse = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FlowlyMailOnboardingBot/1.0" },
    });
    clearTimeout(timeout);

    if (!pageResponse.ok) {
      return NextResponse.json({ error: "site_fetch_failed" }, { status: 502 });
    }
    const html = await pageResponse.text();
    pageText = stripHtml(html).slice(0, MAX_PAGE_TEXT_CHARS);
  } catch (err) {
    console.error("Récupération du site échouée:", err);
    return NextResponse.json({ error: "site_fetch_failed" }, { status: 502 });
  }

  if (!pageText || pageText.length < 30) {
    return NextResponse.json({ error: "site_content_empty" }, { status: 422 });
  }

  const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `Voici le contenu brut extrait du site web d'une entreprise :\n\n${pageText}\n\nRédige en français un texte court et factuel décrivant cette entreprise, destiné à être donné à une IA qui répond aux e-mails clients à sa place. Inclus si l'information est présente : ce que fait l'entreprise, ses horaires, ses services ou produits principaux, ses tarifs. N'invente rien : si une information ne figure pas dans le texte source, ne la mentionne pas. Réponds uniquement avec le texte final, sans préambule ni commentaire.`,
        },
      ],
    }),
  });

  if (!anthropicResponse.ok) {
    const detail = await anthropicResponse.text();
    console.error("Appel Anthropic échoué:", detail);
    return NextResponse.json({ error: "ai_generation_failed" }, { status: 502 });
  }

  const result = await anthropicResponse.json();
  const infosMetier = result?.content
    ?.filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("\n")
    .trim();

  if (!infosMetier) {
    return NextResponse.json({ error: "ai_generation_empty" }, { status: 502 });
  }

  return NextResponse.json({ infos_metier: infosMetier });
}
