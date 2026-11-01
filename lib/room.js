// Sala com vários transmissores, sem servidor próprio.
//
// Como funciona:
// - Cada pessoa tem um Peer com ID aleatório (por onde passa vídeo/áudio).
// - O primeiro a chegar também "segura" o ID fixo da sala (o hub). O hub só
//   guarda a lista de quem está na sala e quem está ao vivo; não passa mídia.
// - Se quem segura o hub sair, os outros disputam o ID e um assume sozinho.
// - Para assistir alguém, você abre conexão direta com essa pessoa e ela te
//   envia o vídeo. Telas só chegam pra quem clicou em assistir; câmeras
//   abrem sozinhas pra todo mundo (são leves).

import { PREFIX, QUALITY, applyBitrate, createPeer, sdpTransform } from "./rtc";

const HEARTBEAT = 5000;
const STALE = 20000;
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

const CAM_BITRATE = 600_000; // câmera vai leve: cada um manda uma cópia pra cada pessoa

const hubId = (room) => `${PREFIX}${room}-hub`;
const nonce = () => Math.random().toString(36).slice(2, 12);

// Cada pessoa pode mandar duas coisas: "screen" (a tela) e "cam" (a câmera).
const key = (id, kind) => `${id}|${kind}`;
const isLive = (m, kind) => !!m && (kind === "cam" ? m.cam : m.live);

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
    this.error = "";

    // hub (só em quem segura o ID da sala)
    this.hubPeer = null;
    this.hubMembers = new Map(); // peerId -> { conn, state, seen }

    // conexão com o hub (todo mundo, inclusive quem é o hub)
    this.hubConn = null;
    this.hubBusy = false;
    this.lastRoster = 0;
    this.members = [];

    // transmissão própria
    this.local = null; // tela: { stream, surface, mode, hasAudio, mix }
    this.cam = null; // câmera: { stream, hasAudio }
    this.quality = "1080p30";
    this.motion = true;
    this.watchers = new Map(); // "viewerId|kind" -> { id, kind, name, conn, call }

    // o que eu estou assistindo
    this.watching = new Map(); // "streamerId|kind" -> { id, kind, conn, call, stream, failed }

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
    this.cam?.stream.getTracks().forEach((t) => t.stop());
    for (const w of this.watchers.values()) w.call?.close();
    for (const e of this.watching.values()) e.call?.close();
    this.hubPeer?.destroy();
    this.peer?.destroy();
  }

  onPeerError(e) {
    if (e.type === "peer-unavailable") {
      const target = (e.message || "").replace(/^.*peer\s+/i, "").trim();
      if (target === hubId(this.room)) {
        if (this.hubConn && !this.hubConn.open) {
          this.hubConn = null;
          this.retryHub();
        }
        return;
      }
      // tentei assistir alguém que já saiu
      this.unwatch(target, "screen");
      this.unwatch(target, "cam");
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
    await this.tryClaimHub();
    this.hubBusy = false;
    this.connectHub();
  }

  tryClaimHub() {
    if (this.hubPeer && !this.hubPeer.destroyed) return Promise.resolve(true);
    return createPeer(hubId(this.room)).then(
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
            this.hubPeer = hp;
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

  connectHub() {
    if (this.destroyed || !this.peer || this.peer.destroyed) return;
    const conn = this.peer.connect(hubId(this.room), { reliable: true });
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
      if (opened) this.retryHub();
      else this.hubFailed();
    };
    conn.on("close", lost);
    conn.on("error", lost);
  }

  // O anfitrião foi achado pelo servidor, mas a conexão direta não fechou:
  // quase sempre é rede bloqueando (CGNAT/4G/firewall) sem TURN.
  hubFailed() {
    this.hubFails = (this.hubFails || 0) + 1;
    if (this.hubFails >= 3) {
      this.error =
        "Não está dando pra conectar na sala. A sua rede (ou a de quem está na sala) pode estar bloqueando conexões diretas. Continuamos tentando…";
    }
    this.retryHub();
  }

  retryHub() {
    if (this.destroyed || this.retrying) return;
    this.retrying = true;
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
    for (const m of this.hubMembers.values()) if (m.conn.open) m.conn.send({ type: "roster", members });
  }

  heartbeat() {
    const now = Date.now();
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
    const conn = this.peer.connect(hubId(this.room), { metadata: { probe: n } });
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
      watchers: this.screenWatchers(),
      cam: !!this.cam,
      camAudio: !!this.cam?.hasAudio,
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

  // Fecha o que estou assistindo de quem saiu ou parou e abre sozinho as
  // câmeras de todo mundo (como numa chamada de vídeo). Telas só abrem com clique.
  reconcile() {
    const byId = new Map(this.members.map((m) => [m.id, m]));
    for (const e of [...this.watching.values()]) {
      if (!isLive(byId.get(e.id), e.kind)) this.unwatch(e.id, e.kind);
    }
    if (!this.peer?.open) return;
    for (const m of this.members) {
      if (m.id !== this.selfId && m.cam && !this.watching.has(key(m.id, "cam"))) this.watch(m.id, "cam");
    }
  }

  // ---------- minha transmissão de tela ----------
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

    this.recallWatchers("screen");
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
    this.dropAllWatchers("screen");
    this.sendState();
    this.emit();
  }

  // ---------- minha câmera ----------
  startCam(stream) {
    const v = stream.getVideoTracks()[0];
    v.contentHint = "motion";
    v.addEventListener("ended", () => {
      if (this.cam?.stream === stream) this.stopCam();
    });
    const prev = this.cam;
    this.cam = { stream, hasAudio: stream.getAudioTracks().length > 0 };
    prev?.stream.getTracks().forEach((t) => t.stop());
    this.recallWatchers("cam");
    this.sendState();
    this.emit();
  }

  stopCam() {
    if (!this.cam) return;
    this.cam.stream.getTracks().forEach((t) => t.stop());
    this.cam = null;
    this.dropAllWatchers("cam");
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
    for (const w of this.watchers.values()) if (w.kind === "screen") applyBitrate(w.call?.peerConnection, cfg.bitrate);
    this.emit();
  }

  setMotion(m) {
    this.motion = m;
    const v = this.local?.stream.getVideoTracks()[0];
    if (v) v.contentHint = m ? "motion" : "detail";
    this.emit();
  }

  // ---------- quem me assiste ----------
  outStream(kind) {
    return kind === "cam" ? this.cam?.stream : this.local?.stream;
  }

  // nomes de quem está vendo minha tela
  screenWatchers() {
    return [...this.watchers.values()].filter((w) => w.kind === "screen").map((w) => w.name);
  }

  recallWatchers(kind) {
    for (const [k, w] of this.watchers) if (w.kind === kind) this.callWatcher(k);
  }

  dropAllWatchers(kind) {
    for (const [k, w] of [...this.watchers]) {
      if (w.kind !== kind) continue;
      w.call?.close();
      if (w.conn.open) w.conn.send({ type: "offline" });
      this.watchers.delete(k);
    }
  }

  onIncomingConn(conn) {
    const name = String(conn.metadata?.name || "anônimo").slice(0, 24);
    // versões antigas não mandam o tipo: era sempre a tela
    const kind = conn.metadata?.kind === "cam" ? "cam" : "screen";
    const k = key(conn.peer, kind);
    conn.on("data", (d) => {
      if (d?.type === "watch") {
        const prev = this.watchers.get(k);
        if (prev && prev.conn !== conn) prev.call?.close();
        this.watchers.set(k, { id: conn.peer, kind, name, conn, call: prev?.conn === conn ? prev.call : null });
        this.callWatcher(k);
        this.sendState();
        this.emit();
      } else if (d?.type === "unwatch") {
        this.dropWatcher(k, conn);
      }
    });
    conn.on("close", () => this.dropWatcher(k, conn));
    conn.on("error", () => this.dropWatcher(k, conn));
  }

  dropWatcher(k, conn) {
    const w = this.watchers.get(k);
    if (!w || (conn && w.conn !== conn)) return;
    w.call?.close();
    this.watchers.delete(k);
    this.sendState();
    this.emit();
  }

  callWatcher(k) {
    const w = this.watchers.get(k);
    if (!w) return;
    w.call?.close();
    w.call = null;
    const stream = this.outStream(w.kind);
    if (!stream) {
      if (w.conn.open) w.conn.send({ type: "offline" });
      return;
    }
    const call = this.peer.call(w.id, stream, { sdpTransform, metadata: { kind: w.kind } });
    if (!call) return;
    w.call = call;
    const pc = call.peerConnection;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState !== "connected") return;
      applyBitrate(pc, w.kind === "cam" ? CAM_BITRATE : QUALITY[this.quality].bitrate);
    });
    call.on("error", (e) => console.warn("call error", e));
  }

  // ---------- assistir os outros ----------
  isWatching(id, kind) {
    return this.watching.has(key(id, kind));
  }
  entry(id, kind) {
    return this.watching.get(key(id, kind));
  }

  // tries: quantas vezes já tentamos de novo sem receber vídeo
  watch(id, kind = "screen", tries = 0) {
    const k = key(id, kind);
    const cur = this.watching.get(k);
    if (cur && !cur.failed) return;
    if (!this.peer || this.peer.destroyed || id === this.selfId) return;
    if (cur) this.closeEntry(cur);
    const conn = this.peer.connect(id, { reliable: true, metadata: { name: this.name, kind } });
    if (!conn) return;
    const entry = { id, kind, conn, call: null, stream: null, tries, failed: false, dead: false };
    this.watching.set(k, entry);
    conn.on("open", () => conn.send({ type: "watch", kind }));
    conn.on("data", (d) => {
      if (d?.type === "offline") this.unwatch(id, kind);
    });

    // Não chegou vídeo (ou a conexão caiu): tenta de novo algumas vezes e,
    // se não der, mostra o erro no lugar do quadro.
    const fail = () => {
      if (this.watching.get(k) !== entry || entry.dead || entry.failed) return;
      if (entry.tries < WATCH_RETRIES) {
        // a entrada continua no mapa (o quadro mostra "Conectando…") até a nova tentativa
        this.closeEntry(entry);
        entry.stream = null;
        this.later(() => {
          if (this.watching.get(k) !== entry) return; // fechou nesse meio tempo
          this.watching.delete(k);
          if (isLive(this.members.find((m) => m.id === id), kind)) this.watch(id, kind, entry.tries + 1);
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
    entry.timer = this.later(() => !entry.stream && fail(), WATCH_TIMEOUT);
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

  unwatch(id, kind = "screen") {
    const k = key(id, kind);
    const e = this.watching.get(k);
    if (!e) return;
    this.watching.delete(k);
    e.dead = true;
    this.cancel(e.timer);
    if (e.conn?.open) e.conn.send({ type: "unwatch" });
    e.call?.close();
    setTimeout(() => e.conn?.close(), 300);
    this.emit();
  }

  onIncomingCall(call) {
    const kind = call.metadata?.kind === "cam" ? "cam" : "screen";
    const k = key(call.peer, kind);
    const e = this.watching.get(k);
    if (!e || e.dead) return call.close();
    call.answer(undefined, { sdpTransform });
    const old = e.call;
    e.call = call;
    old?.close();
    call.on("stream", (s) => {
      if (e.call === call && !e.dead) {
        e.stream = s;
        e.tries = 0; // funcionou: zera as tentativas
        this.cancel(e.timer);
        this.emit();
      }
    });
    const ended = () => {
      if (e.call !== call || e.dead) return;
      e.call = null;
      e.stream = null;
      // Pode ser só troca de janela/câmera (a chamada nova chega já já). Se o
      // vídeo não voltar a tempo, o vigia faz uma nova tentativa.
      this.cancel(e.timer);
      e.timer = this.later(() => this.watching.get(k) === e && !e.stream && e.fail?.(), WATCH_TIMEOUT);
      this.emit();
    };
    call.on("close", ended);
    call.on("error", ended);
  }
}
