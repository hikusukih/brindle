# Brindle

[![CI](https://github.com/hikusukih/brindle/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hikusukih/brindle/actions/workflows/ci.yml)

A self-hosted personal agent with a calm, phone-friendly home: persistent **channels** for conversations, **goals** that keep their own state and act on a schedule, a **feed** of what scheduled work found (also published as RSS), one gallery of **artifacts**, and opt-in **suggestions**. Models are pluggable; credentials go through a key manager that keeps them out of the model's sight.

Early and under construction. The design is in `docs/architecture.md` and the work queue is `.agents/PLAN.md`.

## Quickstart with Docker

Clone this repository, then from its root:

```sh
docker build -t brindle .
docker run -d --name brindle --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v brindle-data:/data \
  brindle
```

Open `http://127.0.0.1:8787`. The page shows a greeting from the server and the time it first started.

- Brindle has no login yet. Inside the container it listens on all interfaces so Docker can forward to it, which is why the `-p` above publishes it on the host's loopback only. Don't publish it more widely until authentication lands.
- Everything Brindle keeps lives in the `brindle-data` volume, mounted at `/data`. Removing the container keeps it; `docker volume rm brindle-data` deletes it.
- To upgrade, pull the new code, rebuild the image, then `docker rm -f brindle` and run the same `docker run` again. Database migrations apply on startup.
- The image runs as an unprivileged user and needs no compiler: the SQLite driver's prebuilt binaries cover amd64 and arm64.

### Moving an install from Bridle

The project used to be called Bridle. An old data directory works as is: at startup the server renames `bridle.sqlite` to `brindle.sqlite` if only the old file exists, and an old `BRIDLE_*` variable is read with a warning when its `BRINDLE_*` twin is unset. Docker volumes can't be renamed, so either keep mounting the old volume (`-v bridle-data:/data`) or copy it into the new one:

```sh
docker volume create brindle-data
docker run --rm -v bridle-data:/from -v brindle-data:/to node:22-bookworm-slim cp -a /from/. /to/
```

Then `docker rm -f bridle`, run the quickstart above, and `docker volume rm bridle-data` once the new install looks right.

## Quickstart from source

Node 22 or newer.

```sh
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8787`. Data lives in `./data` unless `BRINDLE_DATA_DIR` says otherwise; `PORT` and `HOST` change where it listens (loopback by default).

### Choosing a model

Set `BRINDLE_MODEL` to the default model, written `provider:name`: `openai:<model>`, `anthropic:<model>` or `scripted`. Keys come from the environment only: `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. To reach a local OpenAI-compatible server such as Ollama, set `BRINDLE_OPENAI_BASE_URL` (for example `http://127.0.0.1:11434/v1`), and no key is needed. `BRINDLE_ANTHROPIC_BASE_URL` overrides the Anthropic endpoint.

```sh
OPENAI_API_KEY=... BRINDLE_MODEL=openai:<model> npm start
```

Each channel shows the model it uses under its name, and a channel can be set to a different one with the same `provider:name` spelling; clearing the field returns it to the default. A model whose key is missing is refused when you set it. With no default and no choice on the channel, sending a message answers 503.

### Trying runs with the scripted model

For development and acceptance without a key, set `BRINDLE_MODEL=scripted` and `BRINDLE_SCRIPTED_FIXTURE` to a JSON file of canned turns.

```sh
cat > fixture.json <<'JSON'
{ "turns": [{ "text": ["Hello ", "from the scripted model."], "usage": { "inputTokens": 5, "outputTokens": 6 } }] }
JSON
BRINDLE_MODEL=scripted BRINDLE_SCRIPTED_FIXTURE=fixture.json npm start
```

Each turn answers one model call and the script does not loop, so a fixture of N turns serves N calls across all **runs** until the server restarts. Runs left working by a previous process are marked failed at startup.

### Tools

The model can call `web_fetch`, which reads a public page as text (GET only; addresses inside your machine or network are refused unless `BRINDLE_WEB_FETCH_ALLOW_PRIVATE=1`). `web_search` appears when `BRINDLE_SEARCH_URL` points at a SearXNG-style service with its JSON format enabled (for example `http://127.0.0.1:8080`); no key is involved. Tool results are cut to a budget before they go back to the model. A tool that does something in the world would stop and ask first: the channel shows an approval card, and the run waits, even across a restart, until you approve or decline. None of the built-in tools need that yet. The design is in `docs/design/tools.md`.

## Plug-in tools over MCP

Put a `mcp.json` in the data directory to add tools from MCP servers started over stdio:

```json
{
  "servers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "example-notes-mcp-server"],
      "env": ["NOTES_API_KEY"],
      "effects": { "search_notes": "read", "add_note": "local" },
      "defaultEffect": "external"
    }
  }
}
```

Each tool appears to the model as `<server>__<tool>`. You assign its effect level in `effects`: `read` and `local` run at once, `external` waits for your approval. A tool you haven't classified takes `defaultEffect`, which is `external` unless you say otherwise. The server's process gets only `PATH`, `HOME` and the variables named in `env`; secrets come from the environment, never from the file. A server that fails to start is skipped with a warning. Restart Brindle after editing the file.

## Development

`npm run dev` starts the server on port 8787 and Vite on port 5173 with `/api` proxied to the server. `npm test` runs Vitest; `npm run lint` runs Biome (`npm run lint:fix` applies its safe fixes). After changing `src/server/db/schema.ts`, run `npm run db:generate` to add a migration; migrations apply on startup.

## License

MIT; see `LICENSE`.
