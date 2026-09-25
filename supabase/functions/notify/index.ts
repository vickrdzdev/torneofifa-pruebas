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
  target_player: string | null; exclude_player: string | null;
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
  if (row.exclude_player) {
    const { data } = await sb.from("player_accounts").select("player_id");
    return (data || []).map((a) => a.player_id).filter((id) => id !== row.exclude_player);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const { data: secrets } = await sb.from("app_secrets").select("name, value");
  const sec = Object.fromEntries((secrets || []).map((s) => [s.name, s.value]));
  webpush.setVapidDetails(sec.vapid_subject, sec.vapid_public, sec.vapid_private);

  const { data: rows, error } = await sb.rpc("claim_due_notifications", { max_rows: 50 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS });

  // En el orden en que se crearon (p. ej. primero la compra y después el cambio de turno),
  // con una pausa corta entre avisos para que el celular los muestre en ese orden.
  const due = ((rows || []) as (Row & { created_at: string })[])
    .sort((x, y) => Date.parse(x.send_at) - Date.parse(y.send_at) || Date.parse(x.created_at) - Date.parse(y.created_at));
  const summary: string[] = [];
  let sentOne = false;
  for (const row of due) {
    // Recordatorios que se quedaron muy atrás (p. ej. el servidor estuvo apagado) ya no se mandan.
    if (row.kind !== "plain" && Date.now() - Date.parse(row.send_at) > 6 * 3600 * 1000) {
      await sb.from("notifications").update({ result: "vencida" }).eq("id", row.id);
      continue;
    }
    if (sentOne) await new Promise((r) => setTimeout(r, 1500));
    sentOne = true;
    const subs = await subsFor(await recipients(row));
    const payload = JSON.stringify({ title: row.title, body: row.body, image: row.image, url: row.url || "./", tag: row.key });
    let ok = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
        ok++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
    await sb.from("notifications").update({ result: `enviada a ${ok}/${subs.length}` }).eq("id", row.id);
    summary.push(`${row.key}: ${ok}/${subs.length}`);
  }
  return new Response(JSON.stringify({ processed: summary }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
