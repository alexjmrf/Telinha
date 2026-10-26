# telinha

Compartilhamento de tela entre amigos, no navegador, pra substituir o screen share do Discord.

- Todo mundo na sala pode **transmitir ao mesmo tempo**; cada um escolhe quem quer assistir (até 4 lado a lado).
- Escolhe **uma janela específica** (ou uma aba, ou a tela inteira).
- Manda **o som só daquela janela**: Discord, notificações e o resto do PC não vazam.
- Vídeo e áudio vão direto de PC pra PC (WebRTC). A Vercel só serve o site.

---

## Subir na Vercel (passo a passo, Windows)

### 0. O que instalar uma vez

- **Node.js LTS**: https://nodejs.org (next, next, finish). Teste no terminal: `node -v`
- **Git**: https://git-scm.com/download/win (pode aceitar tudo padrão). Teste: `git --version`
- Uma conta no **GitHub** (https://github.com) e uma na **Vercel** (https://vercel.com). Na Vercel, entre com "Continue with GitHub", assim ela já enxerga seus repositórios.

### 1. Testar no seu PC (opcional, mas recomendado)

Abra a pasta `Documentos\ProjetosClaude\telinha` no Explorer, clique na barra de endereço, digite `cmd` e Enter. No terminal que abrir:

```
npm install
npm run dev
```

Abra http://localhost:3000. Para simular duas pessoas, abra o mesmo link de sala numa janela anônima. `Ctrl+C` no terminal para parar.

### 2. Criar o repositório no GitHub

1. Em https://github.com/new crie um repositório chamado `telinha` (pode ser **Private**). **Não** marque "Add a README".
2. No terminal, dentro da pasta do projeto:

```
git init
git add .
git commit -m "telinha"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/telinha.git
git push -u origin main
```

Na primeira vez o Git abre uma janela pedindo login no GitHub: é só autorizar.

> Prefere sem terminal? Use o **GitHub Desktop** (https://desktop.github.com): File → Add local repository → escolha a pasta → "Publish repository".

### 3. Importar na Vercel

1. https://vercel.com/new → na lista "Import Git Repository" clique **Import** no `telinha`.
2. Framework Preset: **Next.js** (já vem selecionado). Não precisa mudar nada.
3. Clique **Deploy** e espere ~1 minuto.
4. Pronto: ela te dá um endereço tipo `https://telinha-xxxx.vercel.app`. Manda pros amigos.

Para trocar o nome do endereço: no projeto na Vercel → **Settings → Domains** → edite para algo como `telinha-alexandre.vercel.app`.

### 4. Atualizar depois

Mudou algum arquivo? No terminal:

```
git add .
git commit -m "ajustes"
git push
```

A Vercel publica a versão nova sozinha em ~1 minuto.

### Alternativa sem GitHub (Vercel CLI)

```
npm i -g vercel
vercel          (primeira vez: faz login e cria o projeto; aceite as sugestões)
vercel --prod   (publica no endereço definitivo)
```

---

## Como usar

1. Alguém clica **Criar sala** e manda o link (ou o código, tipo `gato-1234`).
2. Cada um entra com um apelido.
3. Quem quiser mostrar algo clica **Transmitir uma janela** → no seletor escolhe **Janela** (ou **Aba**) e deixa marcado **"Compartilhar áudio"**.
4. Na lista "Na sala", clique **Assistir** em quem estiver AO VIVO. Dá pra abrir várias ao mesmo tempo; cada tela tem volume próprio, tela cheia (duplo clique) e ✕ para fechar.

### Chat e TTS

- O chat fica na lateral. Quem entra depois vê as últimas 100 mensagens. Links viram clicáveis.
- `/tts seu texto` → a mensagem é lida em voz alta ("fulano disse: …") para todo mundo que estiver com **TTS** ligado.
- Cada pessoa controla o próprio TTS no topo do chat: liga/desliga (fica salvo no navegador), volume e ⏹ para calar na hora.
- Anti-spam: um `/tts` a cada 5 s por pessoa (o excesso aparece com 🔇 e não é lido), até 200 letras por TTS, e no máximo 5 mensagens a cada 5 s.
- A voz é a do próprio navegador/sistema de quem ouve (no Chrome/Edge do Windows vem uma voz em português).

## Como o áudio fica preso à janela

O site chama `getDisplayMedia` com:

| opção | valor | efeito |
|---|---|---|
| `systemAudio` | `"exclude"` | nunca oferece "áudio do sistema inteiro" |
| `windowAudio` | `"window"` | ao escolher uma janela, captura só o som dela |
| `displaySurface` | `"window"` | abre o seletor já na aba "Janela" |

E por garantia: se alguém escolher **tela inteira** pelo botão de janela e o navegador mesmo assim entregar áudio, o site descarta a trilha de áudio.

### Tela inteira sem o som do Discord

O navegador só oferece duas opções de som para tela inteira: o som do PC inteiro (que inclui o Discord) ou nada. Por isso o **"Transmitir tela inteira"** funciona em duas etapas:

1. Escolhe a tela: vai só o vídeo.
2. Em **"Som da transmissão"**, clique **+ Som de uma janela** e escolha o jogo, o player etc. (com **"Compartilhar áudio"** marcado). Dá pra adicionar várias janelas; os sons são misturados numa trilha só. Cada um tem ✕ pra tirar.

O Discord só entra se você escolher a janela dele. Também existe **+ Som do PC inteiro** (`systemAudio: "include"` + `restrictOwnAudio`, que tira o som do próprio telinha), mas aí o Discord vai junto e quem está na call se ouve de volta.

Cada som escolhido abre mais um aviso de compartilhamento do Chrome (pode clicar em **Ocultar**). Som de janela precisa de Chrome/Edge atualizado no Windows; se não aparecer a opção, escolha uma **aba**.

### Onde funciona

| quem transmite | janela com som | aba com som | tela inteira |
|---|---|---|---|
| Chrome / Edge atualizado no **Windows** | ✅ | ✅ | vídeo sem som (de propósito) |
| Chrome / Edge no macOS / Linux | depende da versão* | ✅ | vídeo sem som |
| Firefox / Safari | ❌ som | ❌ som | vídeo sem som |

\* Se a caixa "Compartilhar áudio" não aparecer ao escolher a janela, o site avisa; aí compartilhe uma **aba**.

Quem **assiste** pode usar qualquer navegador moderno.

## Como a sala funciona por dentro

- O primeiro a entrar vira o "anfitrião" invisível da sala: ele só guarda a lista de quem está lá e quem está ao vivo. Se ele sair, outro assume sozinho em ~2 s.
- Para assistir alguém você abre conexão direta com essa pessoa. Quem transmite manda **uma cópia para cada pessoa que abriu a transmissão dele**; quem não abriu não gasta nada.

## Limites e configurações opcionais

- Upload de quem transmite é o gargalo: até ~5 espectadores em 1080p numa conexão boa. Com mais gente, baixe a qualidade no painel.
- A sinalização usa o servidor público gratuito do PeerJS (`0.peerjs.com`). Se ele estiver fora, a sala fica tentando reconectar. Para usar um próprio (ex.: `npx peerjs --port 9000` num VPS), configure na Vercel em **Settings → Environment Variables**:
  - `NEXT_PUBLIC_PEER_HOST` = `seu.servidor.com`
  - `NEXT_PUBLIC_PEER_PORT` = `443`
  - `NEXT_PUBLIC_PEER_PATH` = `/`
- Redes muito fechadas (4G com CGNAT, rede de empresa) podem precisar de um TURN próprio:

  ```
  NEXT_PUBLIC_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:SEU_TURN:3478","username":"u","credential":"p"}]
  ```

  (Metered, Cloudflare Calls e Twilio têm TURN com plano grátis.) Depois de mudar variáveis, faça **Redeploy** na Vercel.
