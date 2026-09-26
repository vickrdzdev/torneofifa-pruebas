// Envía las notificaciones push que ya tocan (tabla notifications).
// La llama pg_cron cada minuto y la app justo después de agregar un aviso;
// llamarla de más no hace daño: solo procesa lo que está pendiente.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Row = {
  id: string; key: string; kind: string; season_id: string | null; jornada_id: string | null;
  target_player: string | null; exclude_player: string | null; exclude_players: string[] | null;
  title: string; body: string; image: string | null; url: string | null; send_at: string;
};

async function recipients(row: Row): Promise<string[] | "all"> {
  const jr = row.jornada_id
    ? (await sb.from("jornadas").select("id, season_id, console1_id, console2_id").eq("id", row.jornada_id).maybeSingle()).data
    : null;
  switch (row.kind) {
    case "lineup_reminder":
    case "lineup_deadline": {
      if (!jr) return [];
      const { data: players } = await sb.from("players").select("id").eq("season_id", jr.season_id);
      const { data: lus } = await sb.from("lineups").select("player_id, submitted_at, late").eq("jornada_id", jr.id);
      const ok = new Set((lus || []).filter((l) => l.submitted_at && (row.kind === "lineup_reminder" || !l.late)).map((l) => l.player_id));
      const missing = (players || []).map((p) => p.id).filter((id) => !ok.has(id));
      // Aviso personal (falta al vencer el plazo): solo si ese player sí la debe.
      return row.target_player ? missing.filter((id) => id === row.target_player) : missing;
    }
    case "console_reminder":
      return jr ? [jr.console1_id, jr.console2_id].filter(Boolean) as string[] : [];
    case "host_reminder":
      return jr && jr.console1_id ? [jr.console1_id] : [];
  }
  if (row.target_player) return [row.target_player];
  const excluded = [row.exclude_player, ...(row.exclude_players || [])].filter(Boolean);
  if (excluded.length) {
    const { data } = await sb.from("player_accounts").select("player_id");
    return (data || []).map((a) => a.player_id).filter((id) => !excluded.includes(id));
  }
  return "all";
}

async function subsFor(who: string[] | "all") {
  if (who === "all") return (await sb.from("push_subscriptions").select("*")).data || [];
  if (!who.length) return [];
  const { data: accs } = await sb.from("player_accounts").select("email").in("player_id", who);
  const emails = [...new Set((accs || []).map((a) => String(a.email).toLowerCase()))];
  if (!emails.length) return [];
  const { data: subs } = await sb.from("push_subscriptions").select("*");
  return (subs || []).filter((s) => emails.includes(String(s.email).toLowerCase()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Envía los avisos que ya tocan. Los de un mismo lote salen en orden: si un
// celular ya recibió uno hace menos de 1 s, el siguiente espera ese resto.
const lastSent = new Map<string, number>();
async function processDue(summary: string[]) {
  const { data: rows, error } = await sb.rpc("claim_due_notifications", { max_rows: 50 });
  if (error) throw new Error(error.message);
  const due = ((rows || []) as (Row & { created_at: string })[])
    .sort((x, y) => Date.parse(x.send_at) - Date.parse(y.send_at) || Date.parse(x.created_at) - Date.parse(y.created_at));
  for (const row of due) {
    // Recordatorios que se quedaron muy atrás (p. ej. el servidor estuvo apagado) ya no se mandan.
    if (row.kind !== "plain" && Date.now() - Date.parse(row.send_at) > 6 * 3600 * 1000) {
      await sb.from("notifications").update({ result: "vencida" }).eq("id", row.id);
      continue;
    }
    const subs = await subsFor(await recipients(row));
    const payload = JSON.stringify({ title: row.title, body: row.body, image: row.image, url: row.url || "./", tag: row.key });
    const results = await Promise.all(subs.map(async (s) => {
      const gap = 1000 - (Date.now() - (lastSent.get(s.endpoint) || 0));
      if (gap > 0) await sleep(gap);
      lastSent.set(s.endpoint, Date.now());
      try {
        // urgency high: Android lo entrega de inmediato aunque el celular esté en reposo.
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: "high" });
        return true;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
        return false;
      }
    }));
    const ok = results.filter(Boolean).length;
    await sb.from("notifications").update({ result: `enviada a ${ok}/${subs.length}` }).eq("id", row.id);
    summary.push(`${row.key}: ${ok}/${subs.length}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const { data: secrets } = await sb.from("app_secrets").select("name, value");
  const sec = Object.fromEntries((secrets || []).map((s) => [s.name, s.value]));
  webpush.setVapidDetails(sec.vapid_subject, sec.vapid_public, sec.vapid_private);
  const body = await req.json().catch(() => ({}));
  const summary: string[] = [];
  try {
    await processDue(summary);
    // La llamada de cada minuto (pg_cron) se queda ~55 s esperando los avisos
    // programados de ese minuto (p. ej. turnos del Draft que se vencen) para
    // mandarlos en el segundo exacto.
    if (body && body.loop) {
      const until = Date.now() + 55 * 1000;
      while (Date.now() < until) {
        const { data: nxt } = await sb.from("notifications").select("send_at").is("sent_at", null)
          .lte("send_at", new Date(until).toISOString()).order("send_at").limit(1);
        if (!nxt || !nxt.length) break;
        const wait = Date.parse(nxt[0].send_at) - Date.now();
        await sleep(Math.max(250, Math.min(wait, until - Date.now())));
        await processDue(summary);
      }
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }
  return new Response(JSON.stringify({ processed: summary }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
