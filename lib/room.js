// Sala com vários transmissores, sem servidor próprio.
//
// Como funciona:
// - Cada pessoa tem um Peer com ID aleatório (por onde passa vídeo/áudio).
// - O primeiro a chegar também "segura" o ID fixo da sala (o hub). O hub só
//   guarda a lista de quem está na sala e quem está ao vivo; não passa mídia.
// - Se quem segura o hub sair, os outros disputam o ID e um assume sozinho.
// - Para assistir alguém, você abre conexão direta com essa pessoa e ela te
//   envia o vídeo. Ninguém recebe transmissão que não abriu.

import { PREFIX, QUALITY, applyBitrate, createPeer, sdpTransform } from "./rtc";

const HEARTBEAT = 5000;
const STALE = 20000;
const HISTORY = 100; // mensagens guardadas
const MAX_MSG = 500; // caracteres por mensagem
const MAX_TTS = 200; // caracteres lidos no /tts
const TTS_COOLDOWN = 5000;

const hubId = (room) => `${PREFIX}${room}-hub`;

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
    peer.on("disconnected", () => this.later(() => !peer.destroyed && peer.reconnect(), 1000));
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
      if (target === hubId(this.room)) {
        if (this.hubConn && !this.hubConn.open) {
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
          hp.on("disconnected", () => setTimeout(() => !hp.destroyed && hp.reconnect(), 1000));
          setTimeout(() => {
            if (!done) {
              hp.destroy();
              finish(false);
            }
          }, 8000);
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
        this.retryHub();
      }
    }, 10000);

    conn.on("open", () => {
      this.cancel(timeout);
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
    const lost = () => {
      if (this.hubConn !== conn) return;
      this.hubConn = null;
      this.retryHub();
    };
    conn.on("close", lost);
    conn.on("error", lost);
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
    hp.on("connection", (conn) => {
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
    }
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
  reconcile() {
    const live = new Set(this.members.filter((m) => m.live).map((m) => m.id));
    for (const id of [...this.watching.keys()]) {
      if (id === this.selfId) continue;
      if (!live.has(id)) this.unwatch(id);
    }
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
  watch(id) {
    if (this.watching.has(id) || !this.peer || this.peer.destroyed) return;
    if (id === this.selfId) {
      if (this.local) this.watching.set(id, { self: true });
      return this.emit();
    }
    const conn = this.peer.connect(id, { reliable: true, metadata: { name: this.name } });
    if (!conn) return;
    const entry = { conn, call: null, stream: null };
    this.watching.set(id, entry);
    conn.on("open", () => conn.send({ type: "watch" }));
    conn.on("data", (d) => {
      if (d?.type === "offline") this.unwatch(id);
    });
    const lost = () => {
      if (this.watching.get(id) !== entry) return;
      this.watching.delete(id);
      entry.call?.close();
      this.emit();
    };
    conn.on("close", lost);
    conn.on("error", lost);
    this.emit();
  }

  unwatch(id) {
    const e = this.watching.get(id);
    if (!e) return;
    this.watching.delete(id);
    if (!e.self) {
      if (e.conn?.open) e.conn.send({ type: "unwatch" });
      e.call?.close();
      setTimeout(() => e.conn?.close(), 300);
    }
    this.emit();
  }

  onIncomingCall(call) {
    const e = this.watching.get(call.peer);
    if (!e || e.self) return call.close();
    call.answer(undefined, { sdpTransform });
    const old = e.call;
    e.call = call;
    old?.close();
    call.on("stream", (s) => {
      if (e.call === call) {
        e.stream = s;
        this.emit();
      }
    });
    call.on("close", () => {
      if (e.call === call) {
        e.call = null;
        e.stream = null;
        this.emit();
      }
    });
  }
}
