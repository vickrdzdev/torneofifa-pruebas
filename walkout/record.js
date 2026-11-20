// Graba el video "walkout" de una compra y lo entrega a la función walkout de Supabase,
// que lo manda al grupo de WhatsApp. Corre en GitHub Actions (.github/workflows/walkout.yml).
//
//   API=<url de la función walkout> JOB=<id> TOKEN=<token> node walkout/record.js
//
// Para probar sin Supabase: LOCAL=<json con los datos de la compra> OUT=<archivo.mp4> node walkout/record.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

// Igual que PHOTO_BASE en index.html.
const PHOTO_BASE = "https://cdn3.futbin.com/content/fifa27/img/players/";
const SECONDS = 11; // largo del video (la tarjeta aparece en 8.5 s)
const FFMPEG = process.env.FFMPEG || (() => { try { return require("ffmpeg-static"); } catch (e) { return "ffmpeg"; } })();
const { API, JOB, TOKEN, LOCAL, OUT } = process.env;
const jobUrl = (extra) => `${API}?job=${encodeURIComponent(JOB)}&token=${encodeURIComponent(TOKEN)}${extra || ""}`;

async function main() {
  // 1. Datos de la compra (la base) + estadísticas y foto (market.json del sitio).
  const job = LOCAL ? JSON.parse(fs.readFileSync(LOCAL, "utf8")) : await (async () => {
    const r = await fetch(jobUrl());
    if (!r.ok) throw new Error("job " + r.status + " " + (await r.text()));
    return r.json();
  })();
  const mk = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "market.json"), "utf8"));
  const row = mk.rows.find((r) => r[0] === job.card_id);
  const c = row ? Object.fromEntries(mk.cols.map((k, i) => [k, row[i]])) : {};
  // Bandera, liga y club: market.json trae la plantilla de la liga de futbin y la firma de cada id.
  const img = (kind, id) => { const im = mk.img && mk.img[kind]; const sig = im && id != null ? im.s[id] : null; return sig ? im.tpl.replace("{id}", id).replace("{s}", sig) : null; };
  const wo = {
    name: job.card_name, pos: job.pos || c.pos, altPos: c.altPos || "", foot: c.foot, sm: job.sm ?? c.sm, wf: job.wf ?? c.wf,
    rat: job.rat, pac: c.pac, sho: c.sho, pas: c.pas, dri: c.dri, def: c.def, phy: c.phy,
    photo: c.photo ? PHOTO_BASE + c.photo : null, price: job.price, buyer: job.buyer,
    nation: img("nation", c.nation), league: img("leagueMono", c.league), club: img("club", c.club),
    // Origen: el equipo de quien lo vendió antes en el torneo o, si no, su club real. Destino: el equipo de quien compra.
    from: job.from_team ? { name: job.from_team, logo: job.from_logo || null } : { name: "", logo: img("club", c.club) },
    to: { name: job.buyer_team || job.buyer, logo: job.buyer_logo || null },
  };
  console.log("Compra:", wo.buyer, "→", wo.name, wo.rat);

  // 2. Graba la animación.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walkout-"));
  const browser = await chromium.launch(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {});
  const ctx = await browser.newContext({ viewport: { width: 720, height: 1280 }, recordVideo: { dir, size: { width: 720, height: 1280 } } });
  const page = await ctx.newPage();
  await page.addInitScript((d) => { window.WO = d; }, wo);
  await page.goto("file://" + path.join(__dirname, "render.html"));
  const loaded = await page.evaluate(() => window.WO_READY);
  console.log("Imágenes:", Object.entries(loaded).map(([u, ok]) => (ok ? "ok " : "FALLÓ ") + u.split("?")[0]).join(" | ") || "ninguna");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.WO_START());
  await page.waitForTimeout(SECONDS * 1000 + 500);
  const wav = Buffer.from(await page.evaluate((s) => window.WO_AUDIO(s), SECONDS), "base64");
  const video = await page.video().path();
  await ctx.close();
  await browser.close();
  fs.writeFileSync(path.join(dir, "audio.wav"), wav);

  // 3. Dónde arranca: primer cuadro que deja de ser blanco (la página es blanca hasta WO_START).
  const stats = execFileSync(FFMPEG, ["-hide_banner", "-i", video, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  let start = 0, t = null;
  for (const line of stats.split("\n")) {
    const pt = line.match(/pts_time:([\d.]+)/); if (pt) t = +pt[1];
    const y = line.match(/YAVG=([\d.]+)/);
    if (y && t != null && +y[1] < 200) { start = Math.max(0, t - 0.04); break; }
  }
  console.log("Inicio de la animación en", start, "s");

  // 4. MP4 que WhatsApp reproduce directo: H.264 + AAC, yuv420p, faststart.
  const out = OUT || path.join(dir, "walkout.mp4");
  execFileSync(FFMPEG, ["-v", "error", "-y", "-ss", String(start), "-t", String(SECONDS), "-i", video, "-i", path.join(dir, "audio.wav"),
    "-map", "0:v", "-map", "1:a", "-vf", "fps=30,scale=720:1280", "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p", "-crf", "26",
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out]);
  const mp4 = fs.readFileSync(out);
  console.log("Video:", (mp4.length / 1024).toFixed(0), "KB");
  if (LOCAL) return;

  // 5. Entrega el video: la función lo guarda y lo manda al grupo.
  const imgs = Object.values(loaded).filter(Boolean).length + "/" + Object.keys(loaded).length;
  const r = await fetch(jobUrl("&imgs=" + imgs), { method: "POST", headers: { "Content-Type": "video/mp4" }, body: mp4 });
  const txt = await r.text();
  console.log("Envío:", r.status, txt);
  if (!r.ok) throw new Error("envío " + r.status);
}

main().catch((e) => { console.error(e); process.exit(1); });
