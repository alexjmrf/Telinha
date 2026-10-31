// Entrega os servidores ICE (STUN + TURN) para o navegador.
//
// O TURN precisa de credenciais, e elas não podem ficar no código do site.
// Configure UM dos provedores abaixo em Settings → Environment Variables na Vercel:
//
//   Cloudflare (1000 GB/mês grátis):
//     CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN
//   Metered (plano grátis):
//     METERED_DOMAIN (ex.: telinha.metered.live), METERED_API_KEY
//
// Sem nada configurado, devolve só STUN (funciona em redes simples).

export const dynamic = "force-dynamic";

const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const TTL = 24 * 60 * 60; // validade das credenciais, em segundos

export async function GET() {
  let turn = [];
  let warn;
  try {
    turn = await turnServers();
    if (!turn.length) warn = "turn-not-configured";
  } catch (e) {
    console.error("TURN falhou:", e);
    warn = "turn-failed";
  }
  return Response.json({ iceServers: [...STUN, ...turn], warn }, { headers: { "Cache-Control": "no-store" } });
}

async function turnServers() {
  const cfId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const cfToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (cfId && cfToken) {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${cfId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL }),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Cloudflare respondeu ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return onlyTurn(j.iceServers);
  }

  const mDomain = process.env.METERED_DOMAIN;
  const mKey = process.env.METERED_API_KEY;
  if (mDomain && mKey) {
    const host = mDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const r = await fetch(`https://${host}/api/v1/turn/credentials?apiKey=${encodeURIComponent(mKey)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Metered respondeu ${r.status}: ${await r.text()}`);
    return onlyTurn(await r.json());
  }

  return [];
}

// Fica só com as entradas TURN (o STUN já vai fixo) e tira a porta 53,
// que os navegadores bloqueiam e só atrasa a conexão.
function onlyTurn(list) {
  return []
    .concat(list || [])
    .filter((s) => s && s.username && s.credential)
    .map((s) => ({
      ...s,
      urls: [].concat(s.urls || s.url || []).filter((u) => /^turns?:/.test(u) && !/:53(\?|$)/.test(u)),
    }))
    .filter((s) => s.urls.length);
}
