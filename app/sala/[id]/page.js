"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Room } from "@/lib/room";
import { QUALITY, displayOptions } from "@/lib/rtc";
import { colorFor, initial } from "@/lib/colors";
import { ScreenMix, audioSourceOptions, screenVideoOptions } from "@/lib/capture";
import Chat, { speak, useTts } from "./Chat";
import { IconCopy, IconFull, IconMute, IconScreen, IconVolume, IconX, Logo } from "../../icons";

const SURFACE_LABEL = { window: "janela", browser: "aba", monitor: "tela inteira" };

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
    <span className="avatar" aria-hidden="true" style={{ background: c.bg, color: c.fg, width: size, height: size }}>
      {initial(name)}
    </span>
  );
}

// ---------- entrada ----------
export default function RoomPage() {
  const { id } = useParams();
  const room = String(id).toLowerCase();
  const [name, setName] = useState(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const saved = load("telinha:name", "");
    setDraft(saved);
    // Se já veio de um clique (ex.: "Criar sala"), entra direto.
    // Senão, pede um clique: isso também libera o som automático no navegador.
    if (saved && navigator.userActivation?.hasBeenActive) setName(saved);
  }, []);

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
  const tts = useTts();
  const ttsRef = tts.ref;

  useEffect(() => {
    setCanShare(!!navigator.mediaDevices?.getDisplayMedia);
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
  const sorted = [...members].sort((a, b) => b.live - a.live || (a.id === r.selfId ? -1 : b.id === r.selfId ? 1 : 0));
  const live = sorted.filter((m) => m.live);
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const tiles = [...r.watching.entries()];
  const notWatched = live.filter((m) => !r.watching.has(m.id) && m.id !== r.selfId);
  const toggleWatch = (id) => (r.watching.has(id) ? r.unwatch(id) : r.watch(id));

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
          {tiles.length === 0 ? (
            <div className="empty-stage">
              {r.status === "conectando" && !r.members.length ? (
                <p>Entrando na sala…</p>
              ) : live.length === 0 ? (
                <>
                  <span style={{ color: "var(--faint)" }}>
                    <IconScreen />
                  </span>
                  <h2>Ninguém transmitindo ainda</h2>
                  <p>Qualquer um na sala pode ir ao vivo. Manda o link pros amigos ou comece você.</p>
                  {canShare && !r.local && (
                    <button className="btn primary" onClick={() => share("window")} disabled={!r.selfId}>
                      Transmitir uma janela
                    </button>
                  )}
                </>
              ) : (
                <>
                  <h2>Ao vivo agora</h2>
                  <div className="row">
                    {live.map((m) => (
                      <button key={m.id} className="btn primary" onClick={() => r.watch(m.id)}>
                        {m.id === r.selfId ? "Ver minha prévia" : `Assistir ${m.name}`}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className={`tiles n${Math.min(tiles.length, 4)}`}>
              {tiles.map(([id, e]) => {
                const self = !!e.self;
                const m = byId[id];
                return (
                  <Tile
                    key={id}
                    self={self}
                    stream={self ? r.local?.stream : e.stream}
                    label={self ? "Você (prévia)" : m?.name || "…"}
                    hasAudio={self ? r.local?.hasAudio : m?.hasAudio}
                    onClose={() => r.unwatch(id)}
                  />
                );
              })}
            </div>
          )}

          {tiles.length > 0 &&
            notWatched.map((m) => (
              <div key={m.id} className="live-banner">
                <span className="dot" />
                <span>
                  <b>{m.name}</b> também está ao vivo
                </span>
                <span className="spacer" />
                <button className="btn primary" onClick={() => r.watch(m.id)}>
                  Assistir {m.name}
                </button>
              </div>
            ))}
        </main>

        {live.length > 0 && (
          <section className="live-chips" aria-labelledby="aovivo">
            <h2 id="aovivo" className="panel-title">
              Ao vivo agora
            </h2>
            <div className="chips">
              {live.map((m) => (
                <button key={m.id} className="chip" aria-pressed={r.watching.has(m.id)} onClick={() => toggleWatch(m.id)}>
                  <span className="dot" />
                  {m.id === r.selfId ? "você" : m.name}
                </button>
              ))}
            </div>
          </section>
        )}

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
                {r.local.mix ? <AudioSources mix={r.local.mix} onAdd={addAudio} /> : <AudioBadge local={r.local} />}
                <p className="hint">
                  {r.watchers.size === 0
                    ? "Ninguém te assistindo ainda."
                    : `Te assistindo: ${[...r.watchers.values()].map((w) => w.name).join(", ")}`}
                </p>
                <div className="btn-row">
                  <button className="btn" onClick={() => share(r.local.mode)}>
                    {r.local.mode === "screen" ? "Trocar tela" : "Trocar janela"}
                  </button>
                  <button className="btn danger" onClick={() => r.stopLive()}>
                    Parar
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
            ) : (
              <p className="mobile-note">No celular dá pra assistir e conversar. Pra transmitir, abra a sala no computador.</p>
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
                const watching = r.watching.has(m.id);
                const n = m.watchers?.length || 0;
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
                          {n > 0 ? ` · ${n} assistindo` : ""}
                        </span>
                      )}
                    </span>
                    {m.live && (
                      <button className={`btn sm ${watching ? "" : "primary"}`} onClick={() => toggleWatch(m.id)}>
                        {watching ? "Fechar" : me ? "Prévia" : "Assistir"}
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
              <p className="hint">Você envia uma cópia pra cada pessoa que te assiste. Com muita gente, baixe a qualidade.</p>
            </details>
          )}

          {r.status === "conectando" && r.members.length > 0 && <p className="hint">Reconectando à sala…</p>}
          {r.error && <p className="err">{r.error}</p>}
        </aside>
      </div>
    </div>
  );
}

// ---------- uma transmissão ----------
function Tile({ stream, label, self, hasAudio, onClose }) {
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
    v.muted = self;
    v.play().catch(() => {
      // Navegador bloqueou som automático: toca mudo e pede um clique.
      v.muted = true;
      setBlocked(true);
      v.play().catch(() => {});
    });
  }, [stream, self]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = vol;
    if (!blocked) v.muted = self || muted;
    save("telinha:vol", String(vol));
  }, [vol, muted, blocked, self]);

  function unlock() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.play().catch(() => {});
    setBlocked(false);
    setMuted(false);
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapRef.current?.requestFullscreen?.();
  }

  const silent = muted || blocked;
  return (
    <figure className="tile" ref={wrapRef} onDoubleClick={fullscreen}>
      <video ref={videoRef} autoPlay playsInline />
      {!stream && <div className="loading">Conectando…</div>}
      <figcaption>
        <span className="pill-live">AO VIVO</span>
        <span className="tag">{label}</span>
        {!self && !hasAudio && <span className="tag dim">sem áudio</span>}
      </figcaption>
      {blocked && stream && (
        <button className="unlock" onClick={unlock}>
          <IconVolume /> Clique para ativar o som
        </button>
      )}
      <div className="controls">
        {self ? (
          <span className="hint">prévia sem som</span>
        ) : hasAudio ? (
          <>
            <button
              className="icon-btn"
              aria-label={silent ? `Ativar som de ${label}` : `Silenciar ${label}`}
              onClick={() => (blocked ? unlock() : setMuted((m) => !m))}
            >
              {silent ? <IconMute /> : <IconVolume />}
            </button>
            <label style={{ display: "flex" }}>
              <span className="sr-only">Volume de {label}</span>
              <input type="range" min="0" max="1" step="0.01" value={vol} onChange={(e) => setVol(parseFloat(e.target.value))} />
            </label>
          </>
        ) : (
          <span className="hint">sem áudio</span>
        )}
        <span className="spacer" />
        <button className="icon-btn" onClick={fullscreen} aria-label="Tela cheia" title="Tela cheia">
          <IconFull />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label={`Fechar transmissão de ${label}`} title="Fechar">
          <IconX />
        </button>
      </div>
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
