// Renueva el registro de notificaciones de un celular. La llama el service
// worker cuando el navegador cambia la suscripción por su cuenta
// (evento pushsubscriptionchange), aunque la persona no tenga la app abierta:
// busca la fila del registro anterior y la actualiza con el nuevo.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const b = await req.json().catch(() => null);
  const oldEndpoint = b && b.oldEndpoint;
  const sub = b && b.sub;
  const ok = (v: unknown) => typeof v === "string" && v.startsWith("https://") && v.length < 2000;
  if (!ok(oldEndpoint) || !sub || !ok(sub.endpoint) || !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
    return json({ error: "datos inválidos" }, 400);
  }
  // Solo se puede renovar un registro que ya existía (quien no conozca el
  // registro anterior no puede ligar un celular a la cuenta de otro).
  const { data: row } = await sb.from("push_subscriptions").select("id").eq("endpoint", oldEndpoint).maybeSingle();
  if (!row) return json({ error: "registro anterior no encontrado" }, 404);
  if (sub.endpoint !== oldEndpoint) await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  const { error } = await sb.from("push_subscriptions")
    .update({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }).eq("id", row.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
});
