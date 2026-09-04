# Bot Discord — Filtro Antinazismo

Bot de moderacao para Discord que remove mensagens e imagens relacionadas a
Hitler/nazismo conforme uma politica configurada.

## O que ele faz

- Detecta nomes e varias formas de escrita.
- Normaliza acentos, pontuacao, numeros e caracteres usados para tentar burlar o filtro.
- Verifica mensagens editadas.
- Mantem um historico curto por usuario para detectar tentativas divididas em varias mensagens.
- Usa Gemini para analise contextual de texto.
- Usa Gemini para analise visual de imagens anexadas.
- Registra ocorrencias em um canal de logs.
- Pode limitar a moderacao a canais especificos.
- Pode configurar cargos de bypass (opcional).

## Importante

Um bot do Discord nao consegue impedir tecnicamente o usuario de apertar
"Enviar" antes de a mensagem chegar ao bot. O comportamento normal e:
mensagem chega -> bot detecta -> bot apaga.

Para apagar mensagens de outros membros, o bot precisa da permissao
"Gerenciar mensagens".

A analise de imagens depende da API Gemini e de uma chave `GEMINI_API_KEY`.
Sem essa chave, o filtro de texto por regras continua funcionando, mas a
analise visual fica desativada.

## Variaveis

Copie `.env.example` para `.env` no ambiente onde o bot for executado.

Nunca publique `.env` no GitHub.

## Executar

```bash
npm install
npm start
```

## GitHub Actions

O workflow em `.github/workflows/check.yml` serve para verificar a sintaxe
quando o codigo e enviado ao GitHub.

Nao use um GitHub-hosted runner como hospedagem 24/7 do bot: jobs hospedados
pelo GitHub tem limite de execucao. Use o GitHub para guardar o codigo e um
servico de hospedagem para manter o processo do bot online continuamente.

## Permissoes do bot

No servidor, o cargo do bot precisa pelo menos de:

- Ver canais
- Ler historico de mensagens
- Enviar mensagens (se quiser logs/avisos)
- Gerenciar mensagens

No Developer Portal, ative o Privileged Gateway Intent:

- Message Content Intent

## Limites

Nenhum filtro baseado em IA e 100% perfeito. Uma imagem pode ser classificada
erradamente e uma tentativa muito sofisticada pode escapar. Por isso o bot
combina regras deterministicas com IA e logs.
