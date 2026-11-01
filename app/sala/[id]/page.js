"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Room } from "@/lib/room";
import { QUALITY, cameraOptions, displayOptions, normalizeRoom, turnStatus } from "@/lib/rtc";
import { colorFor, initial } from "@/lib/colors";
import { ScreenMix, audioSourceOptions, screenVideoOptions } from "@/lib/capture";
import { useBlackFrames } from "@/lib/useBlackFrames";
import { useZoom } from "@/lib/useZoom";
import Chat, { speak, useTts } from "./Chat";
import { IconCopy, IconFull, IconMute, IconVolume, IconX, Logo } from "../../icons";

const SURFACE_LABEL = { window: "janela", browser: "aba", monitor: "tela inteira" };

const CAMERA_ERRORS = {
  NotAllowedError: "Sem permissão pra usar a câmera. Libere no cadeado ao lado do endereço do site.",
  NotFoundError: "Nenhuma câmera encontrada.",
  NotReadableError: "A câmera está sendo usada por outro programa (Discord, OBS…). Feche e tente de novo.",
  OverconstrainedError: "Essa câmera não aceitou a configuração. Tente outra câmera.",
};

async function listCameras() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
}

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function Avatar({ name, size = 30 }) {
  const c = colorFor(name);
  return (
    <span className="avatar" aria-hidden="true" style={{ background: c.bg, color: c.fg, width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      {initial(name)}
    </span>
  );
}

// ---------- entrada ----------
export default function RoomPage() {
  const { id } = useParams();
  const room = normalizeRoom(id);
  // link com acento/maiúscula/espaço: troca só o endereço exibido pela versão
  // limpa (sem navegar: navegar remontaria a sala e derrubaria a conexão)
  useEffect(() => {
    if (room && String(id) !== room) window.history.replaceState(null, "", `/sala/${room}`);
  }, [id, room]);
  const [name, setName] = useState(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const saved = load("telinha:name", "");
    setDraft(saved);
    // Se já veio de um clique (ex.: "Criar sala"), entra direto.
    // Senão, pede um clique: isso também libera o som automático no navegador.
    if (saved && navigator.userActivation?.hasBeenActive) setName(saved);
  }, []);

  if (!room) {
    return (
      <div className="join-page">
        <header>
          <Link href="/" className="logo">
            <Logo />
            <b>telinha</b>
          </Link>
        </header>
        <main>
          <div className="join-card">
            <b>Esse código de sala não é válido.</b>
            <p className="hint">Use só letras, números e hífen, tipo gato-1234.</p>
            <Link href="/" className="btn primary lg">
              Voltar pro início
            </Link>
          </div>
        </main>
      </div>
    );
  }

  if (!name) {
    return (
      <div className="join-page">
        <header>
          <Link href="/" className="logo">
            <Logo />
            <b>telinha</b>
          </Link>
        </header>
        <main>
          <form
            className="join-card"
            onSubmit={(e) => {
              e.preventDefault();
              const n = draft.trim() || "anônimo";
              save("telinha:name", n);
              setName(n);
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={{ fontSize: 14, color: "var(--muted)" }}>Você foi chamado para a sala</span>
              <span className="code-big">{room}</span>
            </div>
            <label className="field">
              Seu apelido
              <input
                className="input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={24}
                placeholder="ex: alexandre"
              />
            </label>
            <button className="btn primary lg" type="submit">
              Entrar na sala
            </button>
            <p className="hint center">Esse clique também libera o som automático do navegador.</p>
          </form>
        </main>
      </div>
    );
  }

  return <RoomView room={room} name={name} />;
}

// ---------- sala ----------
function RoomView({ room, name }) {
  const [, force] = useReducer((x) => x + 1, 0);
  const roomRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const [canShare, setCanShare] = useState(true);
  const [canCam, setCanCam] = useState(true);
  const [camMic, setCamMic] = useState(false);
  const [camCount, setCamCount] = useState(0);
  const [focus, setFocus] = useState(null); // quadro em destaque
  const tts = useTts();
  const ttsRef = tts.ref;

  useEffect(() => {
    setCanShare(!!navigator.mediaDevices?.getDisplayMedia);
    setCanCam(!!navigator.mediaDevices?.getUserMedia);
    setCamMic(load("telinha:cammic", "0") === "1");
    const r = new Room(room, name, force);
    r.onChat = (msg) => {
      if (msg.tts && ttsRef.current.on) speak(msg, ttsRef.current.volume);
    };
    roomRef.current = r;
    r.start();
    force();
    const bye = () => r.destroy();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      r.destroy();
    };
  }, [room, name, ttsRef]);

  const r = roomRef.current;
  if (!r) return null;

  async function share(mode = "window") {
    setErr("");
    try {
      if (mode === "screen") {
        // vídeo da tela inteira; o som é escolhido depois, fonte por fonte
        const s = await navigator.mediaDevices.getDisplayMedia(screenVideoOptions(QUALITY[r.quality]));
        const mix = r.local?.mix || new ScreenMix(() => r.refreshAudio());
        r.goLive(mix.setVideo(s), "screen", { mix });
      } else {
        const s = await navigator.mediaDevices.getDisplayMedia(displayOptions(QUALITY[r.quality], mode));
        r.goLive(s, mode);
      }
    } catch (e) {
      if (e.name !== "NotAllowedError") setErr("Não deu pra capturar: " + e.message);
    }
  }

  async function shareCamera(deviceId, mic = camMic) {
    setErr("");
    try {
      const s = await navigator.mediaDevices.getUserMedia(cameraOptions(mic, deviceId));
      r.startCam(s);
      // a quantidade de câmeras só aparece certa depois da permissão
      setCamCount((await listCameras()).length);
    } catch (e) {
      setErr(CAMERA_ERRORS[e.name] || "Não deu pra abrir a câmera: " + e.message);
      if (r.cam && !r.cam.stream.getVideoTracks().some((t) => t.readyState === "live")) r.stopCam();
    }
  }

  // reabre a câmera (outra câmera ou microfone ligado/desligado).
  // Celular costuma não abrir a mesma câmera duas vezes: solta a atual antes.
  function reopenCamera(deviceId, mic) {
    r.cam?.stream.getTracks().forEach((t) => t.stop());
    shareCamera(deviceId, mic);
  }

  async function nextCamera() {
    const cams = await listCameras();
    if (cams.length < 2) return;
    const cur = r.cam?.stream.getVideoTracks()[0]?.getSettings().deviceId;
    const next = cams[(cams.findIndex((c) => c.deviceId === cur) + 1) % cams.length];
    reopenCamera(next.deviceId, camMic);
  }

  function toggleCamMic(on) {
    setCamMic(on);
    save("telinha:cammic", on ? "1" : "0");
    if (r.cam) reopenCamera(r.cam.stream.getVideoTracks()[0]?.getSettings().deviceId, on);
  }

  async function addAudio(kind) {
    setErr("");
    let s;
    try {
      s = await navigator.mediaDevices.getDisplayMedia(audioSourceOptions(kind));
    } catch (e) {
      if (e.name !== "NotAllowedError") setErr("Não deu pra capturar: " + e.message);
      return;
    }
    const mix = r.local?.mix;
    if (!mix) return s.getTracks().forEach((t) => t.stop()); // parou de transmitir no meio
    if (!mix.addSource(s, kind)) {
      setErr(
        kind === "system"
          ? "Veio sem som: escolha a tela e marque “Compartilhar áudio do sistema”."
          : "Essa janela veio sem som: marque “Compartilhar áudio”. Se a opção não aparecer, seu navegador não captura som de janela; escolha uma aba ou use Chrome/Edge atualizado no Windows."
      );
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/sala/${room}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  const members = r.members.length ? r.members : r.selfId ? [{ id: r.selfId, ...r.stateObj() }] : [];
  // eu primeiro, depois quem está ao vivo
  const sorted = [...members].sort((a, b) => (a.id === r.selfId ? -1 : b.id === r.selfId ? 1 : b.live - a.live));

  // Quadros: primeiro as telas compartilhadas, depois uma por pessoa (câmera ou avatar).
  const tiles = [];
  for (const m of sorted) {
    const me = m.id === r.selfId;
    if (me ? !r.local : !m.live) continue;
    const e = me ? null : r.entry(m.id, "screen");
    tiles.push({
      key: `${m.id}|screen`,
      kind: "screen",
      m,
      me,
      e,
      stream: me ? r.local.stream : e?.stream,
      hasAudio: !me && m.hasAudio,
    });
  }
  for (const m of sorted) {
    const me = m.id === r.selfId;
    const camOn = me ? !!r.cam : !!m.cam;
    const e = me ? null : r.entry(m.id, "cam");
    tiles.push({
      key: `${m.id}|cam`,
      kind: "cam",
      m,
      me,
      e,
      camOn,
      stream: camOn ? (me ? r.cam.stream : e?.stream) : null,
      hasAudio: !me && camOn && m.camAudio,
    });
  }
  const focused = tiles.find((t) => t.key === focus);
  const toggleFocus = (k) => setFocus((f) => (f === k ? null : k));
  const watchScreen = (id) => {
    r.watch(id, "screen");
    setFocus(`${id}|screen`); // abriu uma tela: ela vai pro destaque
  };
  const tileProps = (t, small = false) => ({
    t,
    small,
    focused: focused?.key === t.key,
    onClick: () => toggleFocus(t.key),
    onWatch: () => watchScreen(t.m.id),
    onUnwatch: () => r.unwatch(t.m.id, "screen"),
    onRetry: () => r.watch(t.m.id, t.kind),
  });

  const n = tiles.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const gridStyle = { "--cols": cols, "--rows": Math.ceil(n / cols), "--cols-sm": n <= 2 ? 1 : 2 };

  return (
    <div className="room">
      <header className="topbar">
        <Link href="/" className="logo sm">
          <Logo size={28} live={!!r.local} />
          <b>telinha</b>
        </Link>
        <div className="share">
          <span className="code-chip">{room}</span>
          <button className="btn" onClick={copy} aria-label="Copiar link da sala">
            <IconCopy />
            <span className="copy-label">{copied ? "Copiado!" : "Copiar link"}</span>
          </button>
        </div>
      </header>

      <div className="room-body">
        <main className="stage-area">
          {n === 0 || (r.phase !== "online" && !r.members.length) ? (
            <div className="empty-stage">
              <Loading phase={r.phase} since={r.startedAt} error={r.error} trouble={r.hubTrouble} />
            </div>
          ) : focused ? (
            <div className="focus-view">
              <div className="focus-main">
                <Tile key={focused.key} {...tileProps(focused)} />
              </div>
              {n > 1 && (
                <div className="strip" aria-label="Outros quadros">
                  {tiles.filter((t) => t !== focused).map((t) => <Tile key={t.key} {...tileProps(t, true)} />)}
                </div>
              )}
            </div>
          ) : (
            <div className="grid" style={gridStyle}>
              {tiles.map((t) => <Tile key={t.key} {...tileProps(t)} />)}
            </div>
          )}
          {members.length === 1 && n > 0 && (
            <p className="hint center">Só você por aqui. Manda o link da sala pros amigos.</p>
          )}
        </main>

        <aside className="side">
          <section className="panel you" aria-labelledby="voce">
            <div className="panel-head">
              <h2 id="voce" className="panel-title">
                Você
              </h2>
              {r.local && (
                <span className="you-live">
                  <span className="pill-live">AO VIVO</span>
                  {SURFACE_LABEL[r.local.surface] || r.local.surface}
                </span>
              )}
            </div>

            {r.local ? (
              <>
                <BlackCaptureWarning stream={r.local.stream} surface={r.local.surface} />
                {r.local.mix ? <AudioSources mix={r.local.mix} onAdd={addAudio} /> : <AudioBadge local={r.local} />}
                <p className="hint">
                  {r.screenWatchers().length === 0
                    ? "Ninguém vendo sua tela ainda."
                    : `Vendo sua tela: ${r.screenWatchers().join(", ")}`}
                </p>
                <div className="btn-row">
                  <button className="btn" onClick={() => share(r.local.mode)}>
                    {r.local.mode === "screen" ? "Trocar tela" : "Trocar janela"}
                  </button>
                  <button className="btn danger" onClick={() => r.stopLive()}>
                    Parar tela
                  </button>
                </div>
              </>
            ) : canShare ? (
              <>
                <div className="option">
                  <button className="btn primary wide" onClick={() => share("window")} disabled={!r.selfId}>
                    Transmitir uma janela
                  </button>
                  <p className="hint">
                    No seletor, escolha <b>Janela</b> (ou <b>Aba</b>) e marque <b>“Compartilhar áudio”</b>. Vai só o som
                    dessa janela.
                  </p>
                </div>
                <div className="option">
                  <button className="btn wide" onClick={() => share("screen")} disabled={!r.selfId}>
                    Transmitir tela inteira
                  </button>
                  <p className="hint">Depois você escolhe de quais janelas vem o som. O Discord fica de fora.</p>
                </div>
              </>
            ) : null}

            {canCam && (
              <div className="option cam-option">
                {r.cam ? (
                  <div className="btn-row">
                    {camCount > 1 && (
                      <button className="btn" onClick={nextCamera}>
                        Trocar câmera
                      </button>
                    )}
                    <button className="btn danger" onClick={() => r.stopCam()}>
                      Desligar câmera
                    </button>
                  </div>
                ) : (
                  <button className={`btn wide ${canShare ? "" : "primary"}`} onClick={() => shareCamera()} disabled={!r.selfId}>
                    Ligar câmera
                  </button>
                )}
                <label className="check">
                  <input type="checkbox" checked={camMic} onChange={(e) => toggleCamMic(e.target.checked)} />
                  Microfone junto com a câmera
                </label>
                {camMic && <p className="hint">Se vocês já estão em call no Discord, deixe desligado pra não ter eco.</p>}
              </div>
            )}

            {!canShare && (
              <p className="mobile-note">
                {canCam
                  ? "Pra transmitir a tela, abra a sala no computador."
                  : "Aqui dá pra assistir e conversar. Pra transmitir, abra a sala no computador."}
              </p>
            )}
            {err && <p className="err">{err}</p>}
          </section>

          <section className="panel people" aria-labelledby="nasala">
            <h2 id="nasala" className="panel-title">
              Na sala · {members.length}
            </h2>
            <ul className="members">
              {sorted.map((m) => {
                const me = m.id === r.selfId;
                const watching = r.isWatching(m.id, "screen");
                const nWatch = m.watchers?.length || 0;
                return (
                  <li key={m.id}>
                    <Avatar name={m.name} />
                    <span className="who">
                      <span className="nm">
                        {m.name}
                        {me && <em> (você)</em>}
                      </span>
                      {m.live && (
                        <span className="sub live">
                          ao vivo{m.hasAudio ? "" : " · sem áudio"}
                          {nWatch > 0 ? ` · ${nWatch} assistindo` : ""}
                        </span>
                      )}
                      {m.cam && <span className="sub">câmera ligada{m.camAudio ? " · microfone" : ""}</span>}
                    </span>
                    {m.live && !me && (
                      <button
                        className={`btn sm ${watching ? "" : "primary"}`}
                        onClick={() => (watching ? r.unwatch(m.id, "screen") : watchScreen(m.id))}
                      >
                        {watching ? "Fechar" : "Assistir"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <Chat room={r} selfId={r.selfId} online={r.status === "online"} tts={tts} />

          {canShare && (
            <details className="panel quality">
              <summary className="panel-title">Qualidade da sua transmissão</summary>
              <label className="sr-only" htmlFor="q">
                Resolução
              </label>
              <select id="q" className="input" value={r.quality} onChange={(e) => r.setQuality(e.target.value)}>
                {Object.keys(QUALITY).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <div className="seg" role="group" aria-label="Tipo de conteúdo">
                <button className={r.motion ? "on" : ""} aria-pressed={r.motion} onClick={() => r.setMotion(true)}>
                  Jogo / vídeo
                </button>
                <button className={!r.motion ? "on" : ""} aria-pressed={!r.motion} onClick={() => r.setMotion(false)}>
                  Texto / código
                </button>
              </div>
              <p className="hint">
                Vale só pra tela (a câmera vai sempre leve). Você envia uma cópia pra cada pessoa que te assiste: com muita
                gente, baixe a qualidade.
              </p>
              <p className="hint">
                Servidor de retransmissão (TURN): <b>{turnStatus}</b>
                {turnStatus === "não configurado" && " (pessoas em 4G/CGNAT podem não conectar; veja o README)"}
              </p>
            </details>
          )}

          {r.hubTrouble && r.status === "online" && (
            <p className="hint" role="alert">
              <HubTroubleText />
            </p>
          )}
          {r.status === "conectando" && r.members.length > 0 && (
            <p className="hint">{r.hubTrouble ? <HubTroubleText /> : "Reconectando à sala…"}</p>
          )}
          {r.error && <p className="err">{r.error}</p>}
        </aside>
      </div>
    </div>
  );
}

// ---------- um quadro (tela compartilhada ou pessoa) ----------
function Tile({ t, small, focused, onClick, onWatch, onUnwatch, onRetry }) {
  const { kind, m, me, e, stream, hasAudio } = t;
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const v = parseFloat(load("telinha:vol", "1"));
    if (!Number.isNaN(v)) setVol(v);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream || null;
    if (!stream) return;
    v.muted = me;
    v.play().catch(() => {
      // Navegador bloqueou som automático: toca mudo e pede um clique.
      v.muted = true;
      setBlocked(true);
      v.play().catch(() => {});
    });
  }, [stream, me]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = vol;
    if (!blocked) v.muted = me || muted;
    save("telinha:vol", String(vol));
  }, [vol, muted, blocked, me, stream]);

  function unlock(ev) {
    ev?.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.play().catch(() => {});
    setBlocked(false);
    setMuted(false);
  }

  function fullscreen(ev) {
    ev?.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapRef.current?.requestFullscreen?.();
  }

  const stop = (fn) => (ev) => {
    ev.stopPropagation();
    fn();
  };

  const isScreen = kind === "screen";
  const label = me ? (isScreen ? "Sua tela" : `${m.name} (você)`) : isScreen ? `Tela de ${m.name}` : m.name;
  // só vale pra tela dos outros (câmera escura é normal; a minha tela tem aviso próprio)
  const black = useBlackFrames(isScreen && !me ? stream : null);
  // zoom com a rodinha / pinça: só nas telas, e não nos quadradinhos da fileira
  const zoom = useZoom(wrapRef, isScreen && !small && !!stream);
  const silent = muted || blocked;
  const loading = e && !e.failed && !stream;
  const failed = !!e?.failed;

  let body = null;
  if (failed) {
    body = (
      <div className="tile-msg">
        <p>Não deu pra conectar com {m.name}.{small ? "" : " A rede de um de vocês pode estar bloqueando a conexão."}</p>
        <button className="btn sm primary" onClick={stop(onRetry)}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (isScreen && !me && !e) {
    // tela de outra pessoa que eu ainda não abri
    body = (
      <div className="tile-msg">
        <Avatar name={m.name} size={small ? 32 : 56} />
        <button className={`btn ${small ? "sm" : ""} primary`} onClick={stop(onWatch)}>
          Assistir
        </button>
      </div>
    );
  } else if (!isScreen && !stream) {
    body = (
      <div className="tile-msg">
        <Avatar name={m.name} size={small ? 40 : 84} />
        {loading && !small && <span className="hint">Conectando câmera…</span>}
      </div>
    );
  } else if (loading) {
    body = <div className="tile-msg hint">Conectando…</div>;
  }

  return (
    <figure
      ref={wrapRef}
      className={`tile ${isScreen ? "screen" : "person"} ${small ? "small" : ""} ${focused ? "focused" : ""} ${zoom.zoomed ? "zoomed" : ""}`}
      // com zoom, clicar/arrastar mexe na imagem e não tira o quadro do destaque
      onClick={() => !zoom.wasDrag() && !zoom.zoomed && onClick()}
      onDoubleClick={stream ? fullscreen : undefined}
      title={small ? label : undefined}
      style={zoom.boxStyle}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={zoom.videoStyle}
        className={`${me && !isScreen ? "mirror" : ""} ${stream ? "" : "hidden"}`}
      />
      {body}

      {black && stream && !failed && !small && (
        <div className="tile-note" role="status">
          A imagem de {m.name} está chegando preta. Geralmente é o app bloqueando a captura (Netflix, Prime, Disney+) ou
          jogo em tela cheia exclusiva.
        </div>
      )}

      {isScreen && <span className="pill-live corner">AO VIVO</span>}
      <figcaption className="name-tag">
        {!isScreen && t.camOn && hasAudio && silent && <IconMute size={14} />}
        <span>{label}</span>
      </figcaption>

      {blocked && stream && !small && (
        <button className="unlock" onClick={unlock}>
          <IconVolume /> Clique para ativar o som
        </button>
      )}

      {!small && (stream || (isScreen && e)) && (
        <div className="controls" onClick={(ev) => ev.stopPropagation()}>
          {hasAudio && stream && (
            <>
              <button
                className="icon-btn"
                aria-label={silent ? `Ativar som de ${label}` : `Silenciar ${label}`}
                onClick={() => (blocked ? unlock() : setMuted((x) => !x))}
              >
                {silent ? <IconMute /> : <IconVolume />}
              </button>
              <label style={{ display: "flex" }}>
                <span className="sr-only">Volume de {label}</span>
                <input type="range" min="0" max="1" step="0.01" value={vol} onChange={(ev) => setVol(parseFloat(ev.target.value))} />
              </label>
            </>
          )}
          {isScreen && !hasAudio && !me && stream && <span className="hint">sem áudio</span>}
          <span className="spacer" />
          {zoom.zoomed && (
            <button className="btn sm" onClick={zoom.reset} title="Voltar ao tamanho normal" aria-label="Tirar o zoom">
              {zoom.scale.toFixed(1)}x · voltar
            </button>
          )}
          {stream && (
            <button className="icon-btn" onClick={fullscreen} aria-label="Tela cheia" title="Tela cheia">
              <IconFull />
            </button>
          )}
          {isScreen && !me && e && (
            <button className="icon-btn" onClick={stop(onUnwatch)} aria-label={`Parar de assistir ${label}`} title="Parar de assistir">
              <IconX />
            </button>
          )}
        </div>
      )}
    </figure>
  );
}

// ---------- som da tela inteira ----------
function AudioSources({ mix, onAdd }) {
  const system = mix.sources.find((s) => s.kind === "system");
  return (
    <div className="sources">
      <span className="sources-title">Som da transmissão</span>
      {mix.sources.length === 0 ? (
        <p className="warn">Sem som por enquanto. Adicione o som de uma janela (o jogo, o player…).</p>
      ) : (
        <ul>
          {mix.sources.map((s) => (
            <li key={s.id}>
              <IconVolume size={16} />
              <span>{s.label}</span>
              <button className="icon-btn" aria-label={`Tirar som: ${s.label}`} title="Tirar esse som" onClick={() => mix.remove(s.id)}>
                <IconX size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {system && (
        <p className="warn">
          O som do PC inteiro inclui o Discord: quem está na call vai se ouvir de volta.
          {!system.ownFiltered && " Seu navegador também não tirou o som do telinha, então abaixe as transmissões aqui."}
        </p>
      )}
      <div className="btns">
        <button className="btn sm primary" onClick={() => onAdd("window")}>
          + Som de uma janela
        </button>
        {!system && (
          <button className="btn sm" onClick={() => onAdd("system")}>
            + Som do PC inteiro
          </button>
        )}
      </div>
      <p className="hint">
        O Discord só entra se você escolher a janela dele. Cada som abre um aviso do Chrome; pode clicar em Ocultar.
      </p>
    </div>
  );
}

function AudioBadge({ local }) {
  const { surface, hasAudio } = local;
  if (hasAudio) return <p className="ok">Áudio: só {surface === "browser" ? "desta aba" : "desta janela"}</p>;
  if (surface === "monitor")
    return (
      <p className="warn">
        Tela inteira por aqui vai sem som. Para ter som, pare e use “Transmitir tela inteira”, que deixa escolher as
        janelas.
      </p>
    );
  return (
    <p className="warn">
      Sem áudio. A caixa “Compartilhar áudio” estava desmarcada, ou seu navegador ainda não captura som por janela. Use
      Chrome/Edge atualizado no Windows, ou compartilhe uma <b>aba</b>.
    </p>
  );
}

// ---------- não consigo falar com a sala ----------
function HubTroubleText() {
  return (
    <>
      Não estou conseguindo falar com quem abriu a sala. Ou a pessoa caiu (aí a sala se refaz sozinha em instantes),
      ou a internet de um de vocês bloqueia conexão direta (o servidor de retransmissão TURN resolve isso; veja o
      README). Continuo tentando.
    </>
  );
}

// ---------- carregamento ----------
function Loading({ phase, since, error, trouble }) {
  const [, tick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - since) / 1000);
  return (
    <>
      <span className="spinner big" aria-hidden="true" />
      <h2>{phase === "servidor" ? "Conectando ao servidor…" : "Entrando na sala…"}</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : trouble ? (
        <p role="alert">
          <HubTroubleText />
        </p>
      ) : secs >= 6 ? (
        <p>
          {phase === "servidor"
            ? "O servidor gratuito de conexão está lento agora. Continuo tentando sozinho."
            : "Procurando quem já está na sala. Se você for o primeiro, a sala abre em instantes."}
        </p>
      ) : null}
      {secs >= 20 && <p className="hint">Se travar aqui, recarregue a página.</p>}
    </>
  );
}

// ---------- captura saindo preta (quem transmite) ----------
function BlackCaptureWarning({ stream, surface }) {
  const black = useBlackFrames(stream);
  if (!black) return null;
  return (
    <div className="black-warn" role="alert">
      <b>Sua captura está saindo preta.</b>
      <ul>
        <li>
          <b>Netflix, Prime, Disney+</b> e afins bloqueiam a captura. No Chrome, desative “Usar aceleração de
          hardware” (Configurações → Sistema) e reabra o navegador.
        </li>
        <li>
          <b>Jogo em tela cheia</b>: mude para <b>janela sem bordas</b> nas opções de vídeo do jogo.
        </li>
        {surface === "window" && (
          <li>
            Janela <b>minimizada</b> não é capturada: deixe ela aberta (pode ficar atrás de outras).
          </li>
        )}
      </ul>
    </div>
  );
}
