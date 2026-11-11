// Envía las notificaciones push que ya tocan (tabla notifications).
// La llama pg_cron cada minuto y la app justo después de agregar un aviso;
// llamarla de más no hace daño: solo procesa lo que está pendiente.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// En el proyecto de pruebas, los avisos llevan una marca para no confundirlos con los de producción.
const IS_TEST = (Deno.env.get("SUPABASE_URL") || "").includes("bcvzgwnwjtcmtbhwruhi");
const TEST_TAG = "🧪 PRUEBAS · ";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Row = {
  id: string; key: string; kind: string; season_id: string | null; jornada_id: string | null;
  target_player: string | null; exclude_player: string | null; exclude_players: string[] | null;
  title: string; body: string; image: string | null; url: string | null; send_at: string;
  whatsapp?: boolean; wa_photo?: string | null;
};

async function recipients(row: Row): Promise<string[] | "all"> {
  const jr = row.jornada_id
    ? (await sb.from("jornadas").select("id, season_id, jornada_number, console1_id, console2_id").eq("id", row.jornada_id).maybeSingle()).data
    : null;
  switch (row.kind) {
    case "lineup_reminder":
    case "lineup_deadline": {
      if (!jr) return [];
      const { data: players } = await sb.from("players").select("id").eq("season_id", jr.season_id);
      let ok: Set<string>;
      const { data: fm } = await sb.rpc("lineup_uses_formation", { p_season: jr.season_id, p_number: jr.jornada_number });
      if (fm) {
        // Alineación única por player: cuenta si su alineación vigente está completa.
        const { data: sl } = await sb.from("season_lineups").select("player_id, complete").eq("season_id", jr.season_id);
        ok = new Set((sl || []).filter((l) => l.complete).map((l) => l.player_id));
      } else {
        const { data: lus } = await sb.from("lineups").select("player_id, submitted_at, late").eq("jornada_id", jr.id);
        ok = new Set((lus || []).filter((l) => l.submitted_at && (row.kind === "lineup_reminder" || !l.late)).map((l) => l.player_id));
      }
      const missing = (players || []).map((p) => p.id).filter((id) => !ok.has(id));
      // Aviso personal (falta al vencer el plazo): solo si ese player sí la debe.
      return row.target_player ? missing.filter((id) => id === row.target_player) : missing;
    }
    case "rsvp_reminder": {
      // Solo a quien todavía no confirma si va (el post-FIFA no lleva recordatorio).
      if (!jr) return [];
      const { data: players } = await sb.from("players").select("id").eq("season_id", jr.season_id);
      const { data: rs } = await sb.from("jornada_rsvps").select("player_id, going").eq("jornada_id", jr.id);
      const done = new Set((rs || []).filter((r) => r.going != null).map((r) => r.player_id));
      return (players || []).map((p) => p.id).filter((id) => !done.has(id));
    }
    case "console_reminder":
      return jr ? [jr.console1_id, jr.console2_id].filter(Boolean) as string[] : [];
    case "rsvp_summary":
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

// Resumen para el host al cerrar la confirmación: quién va, quién no y quién no respondió.
async function rsvpSummary(jornadaId: string) {
  const { data: jr } = await sb.from("jornadas").select("season_id").eq("id", jornadaId).maybeSingle();
  if (!jr) return "Cerró la confirmación.";
  const { data: players } = await sb.from("players").select("id, name").eq("season_id", jr.season_id).order("sort_order");
  const { data: rs } = await sb.from("jornada_rsvps").select("player_id, going, post").eq("jornada_id", jornadaId);
  const by = new Map((rs || []).map((r) => [r.player_id, r]));
  const names = (f: (r: { going: boolean | null; post: boolean | null } | undefined) => boolean) => (players || []).filter((p) => f(by.get(p.id))).map((p) => p.name);
  const yes = names((r) => r?.going === true), no = names((r) => r?.going === false), none = names((r) => r?.going == null);
  const post = names((r) => r?.going === true && r?.post === true);
  return `Van ${yes.length}: ${yes.join(", ") || "nadie"}.` + (no.length ? `\nNo van: ${no.join(", ")}.` : "") + (none.length ? `\nSin responder: ${none.join(", ")}.` : "") +
    `\n🍻 Post-FIFA por ahora: ${post.length ? post.join(", ") : "nadie"}.`;
}

// ---- WhatsApp (Green-API): compras y ventas también se publican en el grupo ----
// La librería de imágenes se carga solo al armar la foto: si fallara, las notificaciones siguen.
// deno-lint-ignore no-explicit-any
let IS: any = null;
const imagescript = async () => IS || (IS = await import("https://deno.land/x/imagescript@1.3.0/mod.ts"));
// Agranda con interpolación bilineal (la foto de Futbin mide 51 px; así no se ve en bloques).
// deno-lint-ignore no-explicit-any
function smoothScale(Image: any, img: any, w: number, h: number) {
  const out = new Image(w, h), s = img.bitmap, d = out.bitmap, sw = img.width, sh = img.height;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sh / h - 0.5), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sw / w - 0.5), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = s[(y0 * sw + x0) * 4 + c], b = s[(y0 * sw + x1) * 4 + c], e = s[(y1 * sw + x0) * 4 + c], f = s[(y1 * sw + x1) * 4 + c];
        d[(y * w + x) * 4 + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (e * (1 - tx) + f * tx) * ty;
      }
    }
  }
  return out;
}
// Tarjeta ancha con la foto chica al centro, para que WhatsApp no la estire.
async function photoCard(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("foto " + res.status);
  const { decode, Image } = await imagescript();
  const photo = await decode(new Uint8Array(await res.arrayBuffer()));
  const W = 540, H = 270, S = 153;
  const card = new Image(W, H).fill(Image.rgbaToColor(0x14, 0x28, 0x22, 255));
  const ring = new Image(S + 24, S + 24).fill(Image.rgbaToColor(0x1d, 0x3a, 0x30, 255)).roundCorners(24);
  card.composite(ring, (W - S - 24) / 2, (H - S - 24) / 2);
  card.composite(smoothScale(Image, photo, S, S), (W - S) / 2, (H - S) / 2);
  return await card.encode();
}
async function sendWhatsApp(sec: Record<string, string>, row: Row) {
  const group = sec.whatsapp_group, api = sec.greenapi_url, id = sec.greenapi_instance, token = sec.greenapi_token;
  if (!group || !api || !id || !token) return "";
  const caption = (IS_TEST ? "🧪 PRUEBAS\n" : "") + "*" + row.title + "*" + (row.body ? "\n" + row.body : "");
  let photoErr = "";
  try {
    if (row.wa_photo) {
      try {
        // La tarjeta se guarda en Storage (bucket privado "whatsapp") y Green-API la toma de una liga temporal.
        const png = await photoCard(row.wa_photo);
        const path = `${row.id}.png`;
        const up = await sb.storage.from("whatsapp").upload(path, png, { contentType: "image/png", upsert: true });
        if (up.error) throw new Error("storage " + up.error.message);
        const { data: signed } = await sb.storage.from("whatsapp").createSignedUrl(path, 3600);
        if (!signed) throw new Error("liga temporal");
        const r = await fetch(`${api}/waInstance${id}/sendFileByUrl/${token}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: group, urlFile: signed.signedUrl, fileName: "jugador.png", caption }),
        });
        if (r.ok) return " · WA ok";
        photoErr = "envío " + r.status;
      } catch (e) { photoErr = String((e as Error).message || e).slice(0, 80); /* se manda solo el texto */ }
    }
    const r = await fetch(`${api}/waInstance${id}/sendMessage/${token}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: group, message: caption }),
    });
    return r.ok ? " · WA ok (texto" + (photoErr ? "; foto: " + photoErr : "") + ")" : " · WA error " + r.status;
  } catch (e) {
    return " · WA error";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Envía los avisos que ya tocan. Los de un mismo lote salen en orden: si un
// celular ya recibió uno hace menos de 1 s, el siguiente espera ese resto.
const lastSent = new Map<string, number>();
async function processDue(summary: string[], sec: Record<string, string>) {
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
    if (row.kind === "rsvp_summary" && row.jornada_id) row.body = await rsvpSummary(row.jornada_id);
    const payload = JSON.stringify({ title: (IS_TEST ? TEST_TAG : "") + row.title, body: row.body, image: row.image, url: row.url || "./", tag: row.key });
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
    const wa = row.whatsapp ? await sendWhatsApp(sec, row) : "";
    await sb.from("notifications").update({ result: `enviada a ${ok}/${subs.length}${wa}` }).eq("id", row.id);
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
    await processDue(summary, sec);
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
        await processDue(summary, sec);
      }
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }
  return new Response(JSON.stringify({ processed: summary }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
