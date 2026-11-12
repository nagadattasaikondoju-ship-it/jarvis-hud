# OpenJarvis HUD

A holographic command console for [OpenJarvis](https://github.com/open-jarvis/OpenJarvis).
The interface is hosted on Vercel; the AI runs on your own computer.

**Live:** https://openjarvis-hud.vercel.app

```
Browser (openjarvis-hud.vercel.app)
   │  fetch / SSE, straight from your browser
   ▼
OpenJarvis server on your machine  (http://localhost:8000, `jarvis serve`)
   │  agents, tools, memory, telemetry
   ▼
Ollama + local model (e.g. qwen3.5:2b)
```

Vercel only serves static files. It never sees your prompts or replies.

## Connect your machine

1. Install OpenJarvis, which also installs Ollama and a starter model:
   `curl -fsSL https://open-jarvis.github.io/OpenJarvis/install.sh | bash`
2. Add the API server component:
   `cd ~/.openjarvis/src && uv pip install --python ../.venv/bin/python -e ".[server]"`
3. Start the core and allow only the HUD's origin:
   `OPENJARVIS_CORS_ORIGINS=https://openjarvis-hud.vercel.app jarvis serve --port 8000`
4. Open the site in Chrome, Edge, Brave or Firefox. Safari blocks secure pages from calling `localhost`.
   If the browser asks for access to devices on your local network, allow it.

The **SETUP** panel in the app shows the same commands, including Windows versions, ready to copy.

## Features

- Animated core that shows the current state: standby, listening, processing, responding or offline
- Streaming replies, rendered as markdown
- Live agent activity: tool calls such as `web_search` appear as they happen
- Voice input through the browser's speech recognition, and spoken replies through system voices
- Telemetry: link latency, time to first token, tokens per second, and money and energy saved compared with cloud models (`/v1/savings`)
- Quick protocols: status report, brief me, plan my day, explain simply, run diagnostics
- Model picker, persona (system prompt), API key, and an Ollama-direct mode
- Conversation log saved in your browser, with export to Markdown
- Phone layout and reduced-motion support

## Develop

```bash
npm install
npm run dev        # http://localhost:5173  (allowed by OpenJarvis' default CORS)
npm run build
```

Stack: Vite, React 18, `marked` with DOMPurify. No backend code ships to Vercel.
