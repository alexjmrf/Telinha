// Utilidades de WebRTC / PeerJS.

export const PREFIX = "telinha-v2-";

export function randomRoom() {
  const words = ["gato", "pato", "sapo", "lobo", "urso", "puma", "tatu", "boto", "anta", "jaca", "caju", "coco"];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${w}-${n}`;
}

// ICE: STUN descobre o endereço público; TURN retransmite quando a conexão
// direta é impossível (CGNAT, 4G, rede de empresa). Sem TURN essas pessoas
// não entram na sala. As credenciais TURN vêm de /api/ice (ver README).
// NEXT_PUBLIC_ICE_SERVERS (JSON) continua valendo como substituto manual.
const STUN_ONLY = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

let icePromise = null;
export function iceConfig() {
  const custom = process.env.NEXT_PUBLIC_ICE_SERVERS;
  if (custom) {
    try {
      return Promise.resolve({ iceServers: JSON.parse(custom) });
    } catch {
      console.warn("NEXT_PUBLIC_ICE_SERVERS inválido, usando /api/ice");
    }
  }
  icePromise ??= fetch("/api/ice", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((j) => {
      const iceServers = Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : STUN_ONLY;
      if (!iceServers.some((s) => s.username)) console.warn("telinha: sem servidor TURN; redes fechadas não vão conectar");
      return { iceServers };
    })
    .catch((e) => {
      console.warn("telinha: /api/ice falhou, usando só STUN", e);
      icePromise = null; // tenta de novo no próximo Peer
      return { iceServers: STUN_ONLY };
    });
  return icePromise;
}

export async function createPeer(id) {
  const [{ default: Peer }, config] = await Promise.all([import("peerjs"), iceConfig()]);
  const opts = { config, debug: 1 };
  // Servidor de sinalização próprio (opcional). Sem isso usa o 0.peerjs.com grátis.
  const host = process.env.NEXT_PUBLIC_PEER_HOST;
  if (host) {
    opts.host = host;
    opts.port = Number(process.env.NEXT_PUBLIC_PEER_PORT || 443);
    opts.path = process.env.NEXT_PUBLIC_PEER_PATH || "/";
    opts.secure = process.env.NEXT_PUBLIC_PEER_SECURE !== "false";
  }
  return id ? new Peer(id, opts) : new Peer(opts);
}

// Áudio: Opus estéreo, 128 kbps, sem DTX -> som de jogo/música decente.
export function sdpTransform(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
  if (!m) return sdp;
  const pt = m[1];
  const params = "stereo=1;sprop-stereo=1;maxaveragebitrate=128000;usedtx=0;useinbandfec=1";
  const fmtp = new RegExp(`a=fmtp:${pt} (.*)`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_, rest) => {
      const cleaned = rest
        .split(";")
        .filter((p) => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx|useinbandfec)=/.test(p))
        .join(";");
      return `a=fmtp:${pt} ${cleaned};${params}`;
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${params}`);
}

export const QUALITY = {
  "720p30": { width: 1280, height: 720, frameRate: 30, bitrate: 2_500_000 },
  "1080p30": { width: 1920, height: 1080, frameRate: 30, bitrate: 4_500_000 },
  "1080p60": { width: 1920, height: 1080, frameRate: 60, bitrate: 8_000_000 },
  "1440p60": { width: 2560, height: 1440, frameRate: 60, bitrate: 12_000_000 },
};

// Opções do seletor de compartilhamento.
// - systemAudio: "exclude" -> nunca oferece o áudio do sistema inteiro
// - windowAudio: "window"  -> ao escolher uma janela, captura SÓ o áudio dela (Chrome/Edge recentes)
// - abas do navegador sempre mandam só o áudio da aba
//
// mode "screen": tela inteira COM o som do PC inteiro (opt-in). Usa
// restrictOwnAudio pra tirar da captura o som desta própria aba do telinha
// (transmissões dos outros e TTS), senão os amigos se ouviriam em eco.
export function displayOptions(q, mode = "window") {
  if (mode === "screen") {
    const o = displayOptions(q, "window");
    o.video.displaySurface = "monitor";
    o.audio.restrictOwnAudio = true;
    o.systemAudio = "include";
    o.windowAudio = "system";
    return o;
  }
  return {
    video: {
      displaySurface: "window",
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: q.frameRate, max: q.frameRate },
    },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
      suppressLocalAudioPlayback: false,
    },
    systemAudio: "exclude",
    windowAudio: "window",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    monitorTypeSurfaces: "include",
  };
}

// Ajusta bitrate máximo de vídeo de uma conexão já estabelecida.
export async function applyBitrate(pc, bitrate) {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = bitrate;
    p.degradationPreference = "maintain-framerate";
    try {
      await sender.setParameters(p);
    } catch (e) {
      console.warn("setParameters falhou", e);
    }
  }
}
