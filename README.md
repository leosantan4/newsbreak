# newsbreak

Private dashboard data. Nothing to see at the repo root — see the shared link.

## Duas cópias, um código (desde 2026-10-17)

O sistema oficial (este repositório) é a **única fonte do código**. A cópia PARETO (`leosantan4/pc-7f3a91`, worker `pareto-console-api`, KV `PARETO_KV`) é **gerada** a partir daqui e só difere em configuração: título, endereço do worker, chave de acesso, prefixo `pc_` do localStorage, contas fixas, placeholders e o repositório do sync.

- **Nunca edite a cópia à mão.** Altere `e18176716ee60c8f/index.html` e `worker/worker.js` aqui.
- Para atualizar a cópia: `python3 scripts/make_copy.py --front e18176716ee60c8f/index.html --worker worker/worker.js --keep-from <index.html atual da cópia> --out-front <index.html da cópia> --out-worker <worker.js da cópia>`, depois commit/push no repositório da cópia e `worker/deploy.sh` de lá. A chave da cópia é lida do arquivo atual (`--keep-from`), nunca fica no script.
- O script falha de propósito se algum trecho de configuração mudar de forma, para a cópia nunca sair com dados do oficial. `--inverse` desfaz a transformação (usado para trazer trabalho feito na cópia).
- Deploy do worker sempre pelo `deploy.sh` do respectivo repositório, a partir de árvore limpa igual ao `origin/main`.
- Backups desta unificação: tag `pre-unify-2026-10-17` nos dois repositórios.
