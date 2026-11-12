# API Shopcar Clasure

API de captura de anúncios do Shopcar, com parser de veículos, fila serial e configuração
privada por empresa. Código aberto sob licença MIT. O projeto vem **sem empresas cadastradas,
sem credenciais, sem perfil de navegador e sem banco de dados**.

Requisitos: Node.js 24+, Linux com Xvfb, Playwright e Chromium compatível. Não há dependência
de um site específico ou de TypeScript. O backend de cada site deve implementar o contrato
de fila abaixo. Não há sincronização noturna nem gravação automática de estoque.

## Instalação

```bash
npm ci --ignore-scripts
mkdir -p runtime
chmod 700 runtime
export PLAYWRIGHT_BROWSERS_PATH="$PWD/runtime/browsers"
npx playwright install chromium
# Instale Xvfb e as bibliotecas de sistema do Chromium pelo gerenciador da sua distribuição.
```

Configure um usuário de serviço e uma pasta privada. Não servir a pasta da API por Apache,
Nginx ou outro servidor de arquivos: ela contém os dados privados gerados em produção.
O serviço HTTP foi feito para escutar exclusivamente em `127.0.0.1:4381`.

## Cadastrar uma empresa

Na pasta do projeto:

```bash
npm run company:add -- minha-empresa https://example.com
```

O comando gera dois tokens independentes de 32 bytes, grava arquivos com permissão 0600
em diretório 0700 e não imprime os valores. Recusa sobrescrever uma empresa cadastrada.
O identificador aceita letras minúsculas, números e hífen, até 63 caracteres.
Execute como o usuário de serviço, sem sudo. Não execute junto com uma migração manual
do cadastro; o lock de cadastro impede duas atualizações simultâneas do serviço.

```text
api-shopcar-clasure/
├── companies/
│   ├── README.md                 # único conteúdo público desta pasta
│   └── minha-empresa/            # privado, ignorado pelo Git
│       ├── worker.json           # domínio + dois tokens
│       ├── client.json           # hash da chave da API e limite
│       └── site-config.json      # hash da chave do worker para o backend do site
├── runtime/                      # privado, ignorado pelo Git
│   ├── service.json              # lista de hashes autorizados e configuração do serviço
│   └── state/                    # cache SQLite e perfil exclusivo do navegador
├── examples/service.example.json # exemplo sem chaves e sem clientes
├── scripts/company-add.mjs
├── server.mjs
└── worker.mjs
```

Cada cadastro acrescenta o hash ao `runtime/service.json`. O serviço usa essa lista central;
`client.json` é a cópia por empresa para organização. Alterar só essa cópia não muda o serviço.
O primeiro cadastro cria a configuração; antes disso a API não inicia. O exemplo com
`clients: []` é um modelo vazio, não uma autorização de acesso anônimo.

Após cadastrar, reinicie a captura para carregar a nova chave e inicie **um worker por
empresa**. A captura e o navegador são compartilhados, com uma extração por vez.
Não há um processo de navegador por pasta/empresa.

## Executar

```bash
IMPORTER_CONFIG="$PWD/runtime/service.json" npm start
IMPORTER_WORKER_CONFIG="$PWD/companies/minha-empresa/worker.json" npm run worker
```

O primeiro comando precisa estar sob Xvfb em servidor sem display:

```bash
IMPORTER_CONFIG="$PWD/runtime/service.json" xvfb-run -a npm start
```

Em `runtime/service.json`, `stateDir` precisa ser absoluto. `executablePath` é opcional:
use o Chromium instalado em `runtime/browsers` (mantenha `PLAYWRIGHT_BROWSERS_PATH`
exportado no terminal) ou informe o executável compatível do seu host. O modelo systemd
aponta ao mesmo diretório de instalação, mesmo redefinindo HOME para o estado privado.
No worker, `importerUrl` é opcional e aceita somente loopback; padrão:
`http://127.0.0.1:4381/v1/extract`.

Os modelos `systemd/api-shopcar-clasure.service` e `systemd/api-shopcar-clasure@.service`
usam `/opt/api-shopcar-clasure` e usuário `shopcar`. Ajuste caminhos, Node e usuário antes
de instalar. No modelo por empresa, `%i` é o identificador:

```bash
sudo systemctl enable --now api-shopcar-clasure
sudo systemctl enable --now api-shopcar-clasure@minha-empresa
```

Não iniciar dois workers para a mesma empresa. Revogar uma chave: remover seu hash da
lista `clients` em `runtime/service.json`, reiniciar a captura e parar o worker da empresa.
O cadastro não instala unidades, não reinicia produção e não publica nada automaticamente.

## O que instalar no site da empresa

O site usa seu login administrativo normal para solicitar importações. O frontend não
recebe tokens. No **backend privado do site**, instale o conteúdo de `site-config.json`
no mecanismo de configuração adotado pela integração. Ele contém `enabled` e
`serviceTokenHash`; a chave em claro permanece no worker.

Preferir arquivo fora da raiz web ou variável de ambiente. Se a hospedagem só permitir
pasta dentro da raiz, bloquear explicitamente a leitura HTTP e verificar a proteção
antes de ativar. Não enviar `worker.json` ou credenciais em claro ao frontend.

O worker espera estas ações no backend do site:

| Ação | Quem chama | Autorização e corpo |
| --- | --- | --- |
| POST `/api.php?action=import_enqueue` | painel | sessão + CSRF, `{url}` |
| GET `/api.php?action=import_status&id=...` | painel | sessão dona do pedido |
| POST `/api.php?action=import_claim` | worker | Bearer `siteToken`, `{}` |
| POST `/api.php?action=import_result` | worker | Bearer `siteToken`, `{id, lease, result?, code?}` |

`claim` retorna `{job: {id, url, lease}}` ou `{job: null}`. O worker consulta a cada 2 s,
valida o pedido, captura o anúncio e devolve o resultado. O backend precisa validar a
lease, rejeitar repetições/expiração, limitar os pedidos e isolar as sessões no status.
Este projeto não fornece um backend completo, login ou catálogo para o seu site.

## API local

Todas as rotas exigem `Authorization: Bearer <importerToken>`:

- `GET /v1/health`: saúde, versão e disponibilidade do navegador.
- `GET /v1/metrics`: contadores internos do serviço compartilhado.
- `POST /v1/extract`: `{url, adapter?: "shopcar", raw?: boolean}`.

A resposta inclui `vehicle`, `source` e `warnings`; `raw: true` inclui também `html`.
Códigos: `REJECTED_URL`, `NOT_FOUND`, `BLOCKED`, `TIMEOUT`, `PARSE_FAILED`, `UNAVAILABLE`.
Somente URLs HTTPS do Shopcar são aceitas para anúncios. Recursos auxiliares usam uma
lista exata de hosts Shopcar e Cloudflare necessários (`challenges.cloudflare.com`,
`cloudflareinsights.com`, `static.cloudflareinsights.com`), sem subdomínios arbitrários.
Protocolo, credenciais, porta e endereços resolvidos são validados na requisição inicial
e em cada redirect, inclusive de scripts, fetch e iframes. Um túnel de saída interno,
ligado somente a uma porta efêmera de loopback, aplica essa política também aos frames
isolados e workers do Chromium e conecta diretamente ao IP validado. O TLS entre Chromium
e o portal não é interceptado nem reescrito. HTTP simples, destinos locais, portas diferentes
de 443 e hosts fora da lista são recusados. QUIC e UDP WebRTC sem proxy são desabilitados
para essa instância de navegador. Isso não é um proxy externo/rotativo ou serviço para
contornar proteção; é uma barreira local de destinos, além da validação CDP. As chaves identificam o cliente e seu limite;
a instância atual compartilha navegador, cache e métricas e não oferece isolamento forte
entre locatários. Use instâncias separadas se esse isolamento for requisito do seu produto.

## Segurança e distribuição limpa

`companies/*/` e `runtime/` são ignorados. Nunca forçar sua inclusão com `git add -f`.
Não publicar a pasta de produção inteira, `.env`, bancos, cookies, tokens ou backups.
Não usar `git clean -fdx` em produção: apagaria o conteúdo privado ignorado.

Para gerar um pacote público **a partir do commit revisado**, sem histórico Git:

```bash
git archive --format=zip --prefix=api-shopcar-clasure/ HEAD > api-shopcar-clasure.zip
```

Verifique antes a lista de arquivos rastreados e rode uma varredura de segredos. O ZIP
contém somente o código versionado e exemplos vazios, sem cadastros reais. `private: true`
no package.json apenas impede publicação acidental no npm; o código é aberto pela MIT.

## Testes

```bash
npm test
```

A suíte usa dados sintéticos e servidores locais, sem estoque real. Os testes de navegador
precisam de Chromium instalado, Xvfb e OpenSSL para os certificados sintéticos dos testes. Para um executável já disponível no host:

```bash
CHROMIUM_EXECUTABLE_PATH=/caminho/para/chrome npm test
```

## Limites e licença

A disponibilidade do portal não é garantida. Mudanças de HTML podem exigir manutenção do
parser. Use somente conteúdo que está autorizado a importar e respeite as regras do portal.
Não há stealth, proxy rotativo ou serviço para resolver CAPTCHA. Não interaja com desafios
manuais; em bloqueio persistente, interrompa a importação.

Código deste projeto: [MIT](LICENSE). Playwright tem licença Apache-2.0; Chromium e demais
componentes mantêm suas próprias licenças. Não há vínculo oficial com o Shopcar.
