# Configurações privadas por empresa

Esta pasta vem vazia, exceto por este guia. O cadastro cria uma subpasta privada por
identificador: `companies/minha-empresa/`. Os arquivos reais são ignorados pelo Git.

- `worker.json`: domínio e dois tokens, acessíveis somente ao operador/worker.
- `client.json`: hash da credencial do importador, adapters e limite.
- `site-config.json`: configuração que deve ser instalada no **backend privado do site**.

Não enviar estes arquivos para GitHub, frontend, suporte público ou pacotes de distribuição.
Não usar `git add -f` nem compartilhar o diretório de produção inteiro. Atualizar o código
com Git não deve apagar as pastas ignoradas. Não executar `git clean -fdx` em produção.
