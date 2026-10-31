// Sala com vários transmissores, sem servidor próprio.
//
// Como funciona:
// - Cada pessoa tem um Peer com ID aleatório (por onde passa vídeo/áudio).
// - O primeiro a chegar também "segura" o ID fixo da sala (o hub). O hub só
//   guarda a lista de quem está na sala e quem está ao vivo; não passa mídia.
// - Se quem segura o hub sair, os outros disputam o ID e um assume sozinho.
// - O hub tem 3 "lugares" (slots). Se quem segurava o lugar 0 caiu de forma
//   abrupta, o servidor de conexão ainda acha que ele existe por um tempo (um
//   "fantasma") e ninguém consegue falar com ele: aí a sala usa o lugar 1 (ou
//   2). Quando um lugar menor volta a ter hub, o hub de lugar maior percebe e
//   se desfaz, e todo mundo se junta no menor. Regra: o menor lugar vivo ganha.
// - Para assistir alguém, você abre conexão direta com essa pessoa e ela te
//   envia o vídeo. Ninguém recebe transmissão que não abriu.

import { PREFIX, QUALITY, applyBitrate, createPeer, sdpTransform } from "./rtc";

const HEARTBEAT = 5000;
const STALE = 12000; // sem notícia do hub/membro por esse tempo = sumiu
const HISTORY = 100; // mensagens guardadas
const MAX_MSG = 500; // caracteres por mensagem
const MAX_TTS = 200; // caracteres lidos no /tts
const TTS_COOLDOWN = 5000;

const HUB_CLAIM_TIMEOUT = 12000;
const HUB_CONNECT_TIMEOUT = 12000;
const HUB_LOST_GRACE = 15000; // anfitrião sem servidor por mais que isso larga a sala
const PROBE_EVERY = 30000; // anfitrião confere se ainda é o dono do ID da sala
const WATCH_TIMEOUT = 15000;
const WATCH_RETRIES = 2;

const FRAME_TIMEOUT = 7000; // chegou o stream mas nenhuma imagem
const SLOTS = 3;
const LOWER_PROBE_EVERY = 10000; // hub de lugar > 0 procura um lugar menor vivo
const LIVE_GRACE = 12000; // quem sumiu da lista por pouco tempo (troca de hub) continua ao vivo
// lugar 0 mantém o ID antigo (compatível com quem está com a versão anterior aberta)
const hubId = (room, slot = 0) => `${PREFIX}${room}-hub${slot ? slot : ""}`;
const nonce = () => Math.random().toString(36).slice(2, 12);

async function framesDecoded(pc) {
  let frames = 0;
  try {
    (await pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "video") frames = Math.max(frames, r.framesDecoded || 0);
    });
  } catch {}
  return frames;
}

function reconnectPeer(peer) {
  if (peer.destroyed || !peer.disconnected) return;
  try {
    peer.reconnect();
  } catch (e) {
    console.warn("reconnect falhou", e);
  }
}

export class Room {
  constructor(room, name, onUpdate) {
    this.room = room.toLowerCase();
    this.name = name;
    this.onUpdate = onUpdate;

    this.peer = null;
    this.selfId = null;
    this.status = "conectando"; // conectando | online
    this.startedAt = Date.now();
    this.error = "";
    this.slot = 0; // lugar do hub que vou tentar agora
    this.hubSlot = 0; // lugar do hub que eu seguro (se seguro)

    // hub (só em quem segura o ID da sala)
    this.hubPeer = null;
    this.hubMembers = new Map(); // peerId -> { conn, state, seen }

    // conexão com o hub (todo mundo, inclusive quem é o hub)
    this.hubConn = null;
    this.hubBusy = false;
    this.lastRoster = 0;
    this.members = [];

    // transmissão própria
    this.local = null; // { stream, surface, hasAudio }
    this.quality = "1080p30";
    this.motion = true;
    this.watchers = new Map(); // viewerId -> { name, conn, call }

    // o que eu estou assistindo
    this.watching = new Map(); // streamerId -> { conn, call, stream } | { self: true }

    // chat
    this.messages = [];
    this.hubHistory = [];
    this.onChat = null; // chamado para cada mensagem nova ao vivo (usado pelo TTS)

    this.destroyed = false;
    this.timers = new Set();
  }

  // ---------- util ----------
  emit() {
    if (!this.destroyed) this.onUpdate?.();
  }
  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
  cancel(t) {
    clearTimeout(t);
    this.timers.delete(t);
  }

  // em que etapa do carregamento estamos (mostrado na tela de espera)
  get phase() {
    if (!this.selfId) return "servidor"; // falando com o servidor de conexão
    if (this.status !== "online") return "sala"; // entrando na sala
    return "online";
  }

  // ---------- ciclo de vida ----------
  async start() {
    const peer = await createPeer();
    if (this.destroyed) return peer.destroy();
    this.peer = peer;

    peer.on("open", (id) => {
      this.selfId = id;
      this.error = "";
      this.ensureHub();
    });
    // Caiu a conexão com o servidor de sinalização: as conexões diretas
    // continuam, mas sem ela ninguém novo conecta. Tenta voltar com espera crescente.
    let tries = 0;
    peer.on("open", () => (tries = 0));
    peer.on("disconnected", () => {
      tries += 1;
      this.later(() => reconnectPeer(peer), Math.min(1000 * tries, 10000));
    });
    peer.on("error", (e) => this.onPeerError(e));
    peer.on("connection", (conn) => this.onIncomingConn(conn));
    peer.on("call", (call) => this.onIncomingCall(call));

    if (!this.beat) this.beat = setInterval(() => this.heartbeat(), HEARTBEAT);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.beat);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.local?.stream.getTracks().forEach((t) => t.stop());
    this.local?.mix?.stop();
    for (const w of this.watchers.values()) w.call?.close();
    for (const e of this.watching.values()) e.call?.close();
    this.hubPeer?.destroy();
    this.peer?.destroy();
  }

  onPeerError(e) {
    if (e.type === "peer-unavailable") {
      const target = (e.message || "").replace(/^.*peer\s+/i, "").trim();
      if (target.startsWith(hubId(this.room))) {
        this.lowerProbe?.resolve?.(false, target);
        if (this.hubConn && !this.hubConn.open && target === hubId(this.room, this.slot)) {
          this.hubConn = null;
          this.retryHub();
        }
        return;
      }
      // tentei assistir alguém que já saiu
      if (this.watching.has(target)) this.unwatch(target);
      return;
    }
    if (e.type === "network" || e.type === "server-error" || e.type === "socket-error") {
      this.error = "Sem conexão com o servidor de sinalização, tentando de novo…";
      this.emit();
      // Nunca chegou a abrir: recria o Peer do zero.
      if (!this.selfId && this.peer && !this.restarting) {
        this.restarting = true;
        this.peer.destroy();
        this.peer = null;
        this.later(() => {
          this.restarting = false;
          this.start();
        }, 3000);
      }
      return;
    }
    console.warn("peer error", e);
  }

  // ---------- hub: disputa e conexão ----------
  async ensureHub() {
    if (this.destroyed || this.hubBusy || this.hubConn) return;
    this.hubBusy = true;
    this.status = "conectando";
    this.emit();
    // já seguro um hub: só me conecto nele (a sondagem cuida de juntar salas)
    if (this.hubPeer && !this.hubPeer.destroyed) this.slot = this.hubSlot;
    else if (await this.tryClaimHub(this.slot)) this.claimedOverGhost = this.slot > 0;
    this.hubBusy = false;
    this.connectHub(this.slot);
  }

  tryClaimHub(slot = 0) {
    if (this.hubPeer && !this.hubPeer.destroyed) return Promise.resolve(this.hubSlot === slot);
    return createPeer(hubId(this.room, slot)).then(
      (hp) =>
        new Promise((resolve) => {
          let done = false;
          const finish = (ok) => {
            if (done) return;
            done = true;
            resolve(ok);
          };
          if (this.destroyed) {
            hp.destroy();
            return finish(false);
          }
          hp.on("open", () => {
            if (this.destroyed) {
              hp.destroy();
              return finish(false);
            }
            this.hubPeer = hp;
            this.hubSlot = slot;
            this.setupHub(hp);
            finish(true);
          });
          hp.on("error", (e) => {
            if (e.type === "unavailable-id") {
              hp.destroy();
              finish(false);
            } else if (e.type !== "peer-unavailable") console.warn("hub error", e);
          });
          hp.on("disconnected", () => setTimeout(() => reconnectPeer(hp), 1000));
          setTimeout(() => {
            if (!done) {
              hp.destroy();
              finish(false);
            }
          }, HUB_CLAIM_TIMEOUT);
        })
    );
  }

  connectHub(slot = 0) {
    if (this.destroyed || !this.peer || this.peer.destroyed) return;
    const conn = this.peer.connect(hubId(this.room, slot), { reliable: true });
    if (!conn) return this.retryHub();
    this.hubConn = conn;

    const timeout = this.later(() => {
      if (this.hubConn === conn && !conn.open) {
        conn.close();
        this.hubConn = null;
        this.hubFailed();
      }
    }, HUB_CONNECT_TIMEOUT);

    conn.on("open", () => {
      this.cancel(timeout);
      this.hubFails = 0;
      this.offlineSince = 0;
      this.status = "online";
      this.error = "";
      this.lastRoster = Date.now();
      this.sendState();
      // ajuda um anfitrião novo (que pode ter chegado agora) a ter o histórico completo
      if (this.messages.length) conn.send({ type: "sync", messages: this.messages.slice(-HISTORY) });
      this.emit();
    });
    conn.on("data", (d) => {
      if (d?.type === "roster") {
        this.lastRoster = Date.now();
        this.members = d.members;
        this.reconcile();
        // o hub tem menos mensagens que eu (ex.: juntou duas salas): completo
        const now = Date.now();
        if (typeof d.hist === "number" && d.hist < this.messages.length && now - (this.lastSync || 0) > 8000) {
          this.lastSync = now;
          conn.send({ type: "sync", messages: this.messages.slice(-HISTORY) });
        }
        this.emit();
      } else if (d?.type === "chat") {
        if (this.addMessages([d.msg])) {
          this.onChat?.(d.msg);
          this.emit();
        }
      } else if (d?.type === "history") {
        // histórico ao entrar: mostra, mas não lê em voz alta
        if (this.addMessages(d.messages || [])) this.emit();
      }
    });
    let opened = false;
    conn.on("open", () => (opened = true));
    const lost = () => {
      if (this.hubConn !== conn) return;
      this.cancel(timeout);
      this.hubConn = null;
      if (opened) {
        this.slot = 0; // o hub caiu: volta a procurar a partir do lugar 0
        this.retryHub();
      } else this.hubFailed();
    };
    conn.on("close", lost);
    conn.on("error", lost);
  }

  // O anfitrião foi achado pelo servidor, mas a conexão direta não fechou:
  // quase sempre é rede bloqueando (CGNAT/4G/firewall) sem TURN.
  hubFailed() {
    this.hubFails = (this.hubFails || 0) + 1;
    // o lugar está ocupado mas ninguém responde (fantasma, ou rede bloqueada):
    // tenta o próximo lugar
    if (!(this.hubPeer && !this.hubPeer.destroyed)) this.slot = (this.slot + 1) % SLOTS;
    if (this.hubFails >= 3) {
      this.error =
        "Não está dando pra conectar na sala. A sua rede (ou a de quem está na sala) pode estar bloqueando conexões diretas. Continuamos tentando…";
    }
    this.retryHub();
  }

  retryHub() {
    if (this.destroyed || this.retrying) return;
    this.retrying = true;
    if (this.status === "online" || !this.offlineSince) this.offlineSince = Date.now();
    this.status = "conectando";
    this.emit();
    // espera aleatória para não todo mundo disputar o hub no mesmo instante
    this.later(() => {
      this.retrying = false;
      this.ensureHub();
    }, 500 + Math.random() * 1500);
  }

  // ---------- hub: lado de quem segura a sala ----------
  setupHub(hp) {
    this.hubMembers = new Map();
    // quem assume o hub herda o histórico que já tinha visto
    this.hubHistory = this.messages.slice(-HISTORY);
    this.hubLostAt = 0;
    this.probeFails = 0;
    this.lastProbe = Date.now();
    hp.on("connection", (conn) => {
      // teste de posse do ID (ver probeHub): não é um membro
      const probe = conn.metadata?.probe;
      if (probe) {
        if (this.probe?.nonce === probe) this.probe.ok = true;
        conn.on("open", () => conn.close());
        setTimeout(() => conn.close(), 3000);
        return;
      }
      const touch = () => {
        let m = this.hubMembers.get(conn.peer);
        if (!m || m.conn !== conn) {
          m = { conn, state: { id: conn.peer, name: "…", live: false }, seen: Date.now() };
          this.hubMembers.set(conn.peer, m);
        }
        m.seen = Date.now();
        return m;
      };
      conn.on("open", () => {
        touch();
        conn.send({ type: "history", messages: this.hubHistory });
        this.broadcastRoster();
      });
      conn.on("data", (d) => {
        const m = touch();
        if (d?.type === "state") {
          m.state = { ...d.state, id: conn.peer };
          this.broadcastRoster();
        } else if (d?.type === "chat") {
          this.hubChat(m, conn.peer, d.text);
        } else if (d?.type === "sync" && Array.isArray(d.messages)) {
          this.hubMerge(d.messages);
        }
      });
      const drop = () => {
        const m = this.hubMembers.get(conn.peer);
        if (m?.conn === conn) {
          this.hubMembers.delete(conn.peer);
          this.broadcastRoster();
        }
      };
      conn.on("close", drop);
      conn.on("error", drop);
    });
  }

  hubChat(m, from, raw) {
    let text = String(raw || "").replace(/\s+/g, " ").trim().slice(0, MAX_MSG);
    if (!text) return;
    const now = Date.now();
    // anti-flood: no máximo 5 mensagens a cada 5 s por pessoa
    m.sent = (m.sent || []).filter((t) => now - t < 5000);
    if (m.sent.length >= 5) return;
    m.sent.push(now);

    let tts = false;
    let ttsBlocked = false;
    const cmd = text.match(/^\/tts\s+(.+)/i);
    if (cmd) {
      text = cmd[1].slice(0, MAX_TTS);
      // um TTS a cada 5 s por pessoa
      if (now - (m.lastTts || 0) < TTS_COOLDOWN) ttsBlocked = true;
      else {
        tts = true;
        m.lastTts = now;
      }
    }
    const msg = {
      id: Math.random().toString(36).slice(2) + now.toString(36),
      from,
      name: m.state.name || "anônimo",
      text,
      tts,
      ttsBlocked,
      ts: now,
    };
    this.hubHistory.push(msg);
    if (this.hubHistory.length > HISTORY) this.hubHistory.shift();
    for (const x of this.hubMembers.values()) if (x.conn.open) x.conn.send({ type: "chat", msg });
  }

  // junta no histórico do hub mensagens que algum membro já tinha visto
  hubMerge(list) {
    const seen = new Set(this.hubHistory.map((m) => m.id));
    const fresh = list
      .filter((m) => m && typeof m.id === "string" && typeof m.text === "string" && !seen.has(m.id))
      .map((m) => ({
        id: m.id.slice(0, 40),
        from: String(m.from || "").slice(0, 64),
        name: String(m.name || "anônimo").slice(0, 24),
        text: m.text.slice(0, MAX_MSG),
        tts: !!m.tts,
        ttsBlocked: !!m.ttsBlocked,
        ts: Number(m.ts) || 0,
      }));
    if (!fresh.length) return;
    this.hubHistory = [...this.hubHistory, ...fresh].sort((a, b) => a.ts - b.ts).slice(-HISTORY);
    for (const x of this.hubMembers.values()) if (x.conn.open) x.conn.send({ type: "history", messages: this.hubHistory });
  }

  broadcastRoster() {
    const members = [...this.hubMembers.values()].map((m) => m.state);
    const hist = this.hubHistory.length;
    for (const m of this.hubMembers.values()) if (m.conn.open) m.conn.send({ type: "roster", members, hist });
  }

  heartbeat() {
    const now = Date.now();
    // sem falar com a sala há um tempo: a lista que tenho está velha, apago
    if (this.status !== "online" && this.offlineSince && now - this.offlineSince > 15000 && this.members.length) {
      this.members = [];
      this.emit();
    }
    this.reconcile();
    // membro: avisa que está vivo; se o hub sumiu, troca de hub
    if (this.hubConn?.open) {
      this.hubConn.send({ type: "ping" });
      if (now - this.lastRoster > STALE) {
        const c = this.hubConn;
        this.hubConn = null;
        c.close();
        this.retryHub();
      }
    }
    // hub: remove quem parou de responder e reenvia a lista
    if (this.hubPeer && !this.hubPeer.destroyed) {
      for (const [id, m] of this.hubMembers) {
        if (now - m.seen > STALE) {
          this.hubMembers.delete(id);
          m.conn.close();
        }
      }
      this.broadcastRoster();
      this.checkHubOwnership(now);
      if (this.hubPeer && this.hubSlot > 0 && now - (this.lastLowerProbe || 0) > LOWER_PROBE_EVERY) {
        this.lastLowerProbe = now;
        this.probeLowerSlot();
      }
    }
    // abri um lugar reserva porque o principal não respondia, e continuo sozinho
    const aloneInBackup = this.hubPeer && this.hubSlot > 0 && this.claimedOverGhost && this.hubMembers.size <= 1;
    if (aloneInBackup !== !!this.backupAlone) {
      this.backupAlone = aloneInBackup;
      this.emit();
    }
  }

  // Aviso pra tela: não consigo falar com quem abriu a sala.
  get hubTrouble() {
    if (this.backupAlone) return true;
    return this.status !== "online" && (this.hubFails || 0) >= 2;
  }

  // Sou hub num lugar > 0: existe hub vivo num lugar menor? Se sim, largo o
  // meu; meus membros (e eu) se reconectam e acham o lugar menor.
  async probeLowerSlot() {
    if (this.lowerProbe || !this.hubPeer || !this.hubSlot || !this.peer?.open) return;
    for (let slot = 0; slot < this.hubSlot; slot++) {
      const alive = await new Promise((resolve) => {
        const id = hubId(this.room, slot);
        const conn = this.peer.connect(id, { reliable: true, metadata: { probe: "lugar-menor" } });
        if (!conn) return resolve(false);
        const t = setTimeout(() => end(false), 5000);
        const end = (ok) => {
          clearTimeout(t);
          this.lowerProbe = null;
          setTimeout(() => {
            try {
              conn.close();
            } catch {}
          }, 200);
          resolve(ok);
        };
        this.lowerProbe = { resolve: (ok, target) => (!target || target === id) && end(ok) };
        conn.on("open", () => end(true));
        conn.on("error", () => end(false));
      });
      if (alive && this.hubPeer) {
        this.slot = slot;
        this.stepDown(`o lugar ${slot} voltou`);
        return;
      }
    }
  }

  // Evita a "sala dividida": se o anfitrião perde o ID da sala no servidor
  // (queda de rede, PC dormiu), quem chega depois vira outro anfitrião e as
  // duas turmas não se enxergam. Aqui o anfitrião confere se ainda é o dono
  // e, se não for, larga a sala para todo mundo se juntar no anfitrião certo.
  checkHubOwnership(now) {
    const hp = this.hubPeer;
    if (hp.disconnected) {
      this.hubLostAt ||= now;
      // só larga se o servidor está no ar pra mim (senão é queda geral e é melhor segurar)
      if (now - this.hubLostAt > HUB_LOST_GRACE && this.peer?.open) this.stepDown("sem servidor");
      return;
    }
    this.hubLostAt = 0;
    if (!hp.open || !this.peer?.open || this.probe || now - this.lastProbe < PROBE_EVERY) return;
    this.probeHub();
  }

  // Abre uma conexão para o ID da sala a partir do meu Peer normal. Se o
  // servidor entregar no meu próprio hub, ainda sou o dono.
  probeHub() {
    const n = nonce();
    const conn = this.peer.connect(hubId(this.room, this.hubSlot), { metadata: { probe: n } });
    this.lastProbe = Date.now();
    this.probe = { nonce: n, ok: false };
    this.later(() => {
      if (this.probe?.nonce !== n) return;
      const ok = this.probe.ok;
      this.probe = null;
      conn?.close();
      if (ok) this.probeFails = 0;
      else if (++this.probeFails >= 2) this.stepDown("outro anfitrião");
      else this.lastProbe = 0; // confere de novo logo
    }, 8000);
  }

  stepDown(why) {
    const hp = this.hubPeer;
    if (!hp) return;
    console.warn("telinha: deixando de ser anfitrião:", why);
    this.hubPeer = null;
    this.hubMembers = new Map();
    this.hubLostAt = 0;
    this.probeFails = 0;
    this.probe = null;
    this.claimedOverGhost = false;
    this.backupAlone = false;
    hp.destroy(); // fecha as conexões dos membros; eles procuram o anfitrião certo
    if (this.hubConn) {
      const c = this.hubConn;
      this.hubConn = null;
      c.close();
    }
    this.retryHub();
  }

  stateObj() {
    return {
      name: this.name,
      live: !!this.local,
      hasAudio: !!this.local?.hasAudio,
      surface: this.local?.surface || null,
      watchers: [...this.watchers.values()].map((w) => w.name),
    };
  }

  sendState() {
    if (this.hubConn?.open) this.hubConn.send({ type: "state", state: this.stateObj() });
  }

  // ---------- chat ----------
  sendChat(text) {
    if (!this.hubConn?.open) return false;
    this.hubConn.send({ type: "chat", text: String(text).slice(0, MAX_MSG + 10) });
    return true;
  }

  // junta mensagens sem duplicar; retorna true se entrou algo novo
  addMessages(list) {
    const seen = new Set(this.messages.map((m) => m.id));
    const fresh = list.filter((m) => m && m.id && !seen.has(m.id));
    if (!fresh.length) return false;
    this.messages = [...this.messages, ...fresh].sort((a, b) => a.ts - b.ts).slice(-HISTORY);
    return true;
  }

  // fecha o que estou assistindo de quem saiu ou parou
  // Fecha o que estou assistindo de quem PAROU de transmitir. Quem só sumiu
  // da lista por alguns segundos (troca de hub, lista apagada) continua: a
  // transmissão é direta e não depende do hub.
  reconcile() {
    if (this.status !== "online") return;
    const now = Date.now();
    this.lastSeenLive ||= {};
    for (const m of this.members) if (m.live) this.lastSeenLive[m.id] = now;
    for (const id of [...this.watching.keys()]) {
      if (id === this.selfId) continue;
      const m = this.members.find((x) => x.id === id);
      if (m ? !m.live : now - (this.lastSeenLive[id] || 0) > LIVE_GRACE) this.unwatch(id);
    }
  }

  isLive(id) {
    const m = this.members.find((x) => x.id === id);
    if (m) return !!m.live;
    return Date.now() - (this.lastSeenLive?.[id] || 0) < LIVE_GRACE;
  }

  // ---------- minha transmissão ----------
  // mode "window": som só da janela/aba (tela inteira vai muda)
  // mode "screen": tela inteira; o som vem de um ScreenMix (extra.mix) com as
  //                fontes que a pessoa escolher (janelas e/ou PC inteiro)
  goLive(stream, mode = "window", extra = {}) {
    const v = stream.getVideoTracks()[0];
    const a = stream.getAudioTracks()[0];
    const surface = v.getSettings().displaySurface || "window";

    // No modo janela, tela inteira não leva som (evita vazar áudio do PC).
    if (mode !== "screen" && surface === "monitor" && a) {
      a.stop();
      stream.removeTrack(a);
    }
    const ownFiltered = !!stream.getAudioTracks()[0]?.getSettings?.().restrictOwnAudio;

    v.contentHint = this.motion ? "motion" : "detail";
    v.addEventListener("ended", () => {
      if (this.local?.stream === stream) this.stopLive();
    });

    const prev = this.local;
    const mix = extra.mix || null;
    this.local = {
      stream,
      surface,
      mode,
      ownFiltered,
      mix,
      hasAudio: mix ? mix.sources.length > 0 : stream.getAudioTracks().length > 0,
    };
    // para só o que não continua na transmissão nova (ex.: a trilha do mix fica)
    const keep = new Set(stream.getTracks());
    prev?.stream.getTracks().forEach((t) => !keep.has(t) && t.stop());
    if (prev?.mix && prev.mix !== mix) prev.mix.stop();

    for (const id of this.watchers.keys()) this.callWatcher(id);
    this.sendState();
    this.emit();
  }

  // chamado quando fontes de som do mix entram/saem
  refreshAudio() {
    if (!this.local?.mix) return;
    const has = this.local.mix.sources.length > 0;
    if (has !== this.local.hasAudio) {
      this.local.hasAudio = has;
      this.sendState();
    }
    this.emit();
  }

  stopLive() {
    if (!this.local) return;
    this.local.stream.getTracks().forEach((t) => t.stop());
    this.local.mix?.stop();
    this.local = null;
    for (const w of this.watchers.values()) {
      w.call?.close();
      if (w.conn.open) w.conn.send({ type: "offline" });
    }
    this.watchers.clear();
    this.watching.delete(this.selfId);
    this.sendState();
    this.emit();
  }

  async setQuality(q) {
    this.quality = q;
    const cfg = QUALITY[q];
    const v = this.local?.stream.getVideoTracks()[0];
    if (v) {
      try {
        await v.applyConstraints({
          width: { ideal: cfg.width },
          height: { ideal: cfg.height },
          frameRate: { ideal: cfg.frameRate, max: cfg.frameRate },
        });
      } catch {}
    }
    for (const w of this.watchers.values()) applyBitrate(w.call?.peerConnection, cfg.bitrate);
    this.emit();
  }

  setMotion(m) {
    this.motion = m;
    const v = this.local?.stream.getVideoTracks()[0];
    if (v) v.contentHint = m ? "motion" : "detail";
    this.emit();
  }

  onIncomingConn(conn) {
    const name = String(conn.metadata?.name || "anônimo").slice(0, 24);
    conn.on("data", (d) => {
      if (d?.type === "watch") {
        const prev = this.watchers.get(conn.peer);
        if (prev && prev.conn !== conn) prev.call?.close();
        this.watchers.set(conn.peer, { name, conn, call: prev?.conn === conn ? prev.call : null });
        this.callWatcher(conn.peer);
        this.sendState();
        this.emit();
      } else if (d?.type === "unwatch") {
        this.dropWatcher(conn.peer, conn);
      }
    });
    conn.on("close", () => this.dropWatcher(conn.peer, conn));
    conn.on("error", () => this.dropWatcher(conn.peer, conn));
  }

  dropWatcher(id, conn) {
    const w = this.watchers.get(id);
    if (!w || (conn && w.conn !== conn)) return;
    w.call?.close();
    this.watchers.delete(id);
    this.sendState();
    this.emit();
  }

  callWatcher(id) {
    const w = this.watchers.get(id);
    if (!w) return;
    w.call?.close();
    w.call = null;
    if (!this.local) {
      if (w.conn.open) w.conn.send({ type: "offline" });
      return;
    }
    const call = this.peer.call(id, this.local.stream, { sdpTransform });
    if (!call) return;
    w.call = call;
    const pc = call.peerConnection;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") applyBitrate(pc, QUALITY[this.quality].bitrate);
    });
    call.on("error", (e) => console.warn("call error", e));
  }

  // ---------- assistir os outros ----------
  // tries: quantas vezes já tentamos de novo sem receber vídeo
  watch(id, tries = 0) {
    const cur = this.watching.get(id);
    if (cur && !cur.failed) return;
    if (!this.peer || this.peer.destroyed) return;
    if (id === this.selfId) {
      if (this.local) this.watching.set(id, { self: true });
      return this.emit();
    }
    if (cur) this.closeEntry(cur);
    const conn = this.peer.connect(id, { reliable: true, metadata: { name: this.name } });
    if (!conn) return;
    const entry = { conn, call: null, stream: null, tries, failed: false, dead: false };
    this.watching.set(id, entry);
    conn.on("open", () => conn.send({ type: "watch" }));
    conn.on("data", (d) => {
      if (d?.type === "offline") this.unwatch(id);
    });

    // Não chegou vídeo (ou a conexão caiu): tenta de novo algumas vezes e,
    // se não der, mostra o erro no lugar da transmissão.
    const fail = () => {
      if (this.watching.get(id) !== entry || entry.dead || entry.failed) return;
      if (entry.tries < WATCH_RETRIES) {
        // a entrada continua no mapa (o quadro mostra "Conectando…") até a nova tentativa
        this.closeEntry(entry);
        entry.stream = null;
        this.later(() => {
          if (this.watching.get(id) !== entry) return; // fechou nesse meio tempo
          this.watching.delete(id);
          if (this.isLive(id)) this.watch(id, entry.tries + 1);
          else this.emit();
        }, 1000);
      } else {
        this.closeEntry(entry);
        entry.failed = true;
        entry.stream = null;
      }
      this.emit();
    };
    entry.fail = fail;
    entry.timer = this.later(() => this.checkVideo(id, entry), WATCH_TIMEOUT);
    conn.on("close", fail);
    conn.on("error", fail);
    this.emit();
  }

  // fecha as conexões de uma entrada; eventos atrasados dela passam a ser ignorados
  closeEntry(e) {
    e.dead = true;
    this.cancel(e.timer);
    e.call?.close();
    e.conn?.close();
  }

  unwatch(id) {
    const e = this.watching.get(id);
    if (!e) return;
    this.watching.delete(id);
    if (!e.self) {
      e.dead = true;
      this.cancel(e.timer);
      if (e.conn?.open) e.conn.send({ type: "unwatch" });
      e.call?.close();
      setTimeout(() => e.conn?.close(), 300);
    }
    this.emit();
  }

  onIncomingCall(call) {
    const e = this.watching.get(call.peer);
    if (!e || e.self || e.dead) return call.close();
    call.answer(undefined, { sdpTransform });
    const old = e.call;
    e.call = call;
    old?.close();
    call.on("stream", (s) => {
      if (e.call === call && !e.dead) {
        e.stream = s;
        // o stream chegou, mas só vale quando chegar imagem: o vigia confere
        this.cancel(e.timer);
        e.timer = this.later(() => this.checkVideo(call.peer, e), FRAME_TIMEOUT);
        this.emit();
      }
    });
    const ended = () => {
      if (e.call !== call || e.dead) return;
      e.call = null;
      e.stream = null;
      // Pode ser só troca de janela (a chamada nova chega já já). Se o vídeo
      // não voltar a tempo, o vigia faz uma nova tentativa.
      this.cancel(e.timer);
      e.timer = this.later(() => this.checkVideo(call.peer, e), WATCH_TIMEOUT);
      this.emit();
    };
    call.on("close", ended);
    call.on("error", ended);
  }

  // Chegou imagem? "Stream chegou" não basta: a conexão pode fechar e o
  // vídeo nunca vir (tela preta). Sem imagem, conta como falha e tenta de novo.
  async checkVideo(id, e) {
    if (this.watching.get(id) !== e || e.dead || e.failed) return;
    if (e.stream && (await framesDecoded(e.call?.peerConnection)) > 0) {
      e.tries = 0; // funcionou: zera as tentativas
      return;
    }
    if (this.watching.get(id) === e) e.fail?.();
  }
}
