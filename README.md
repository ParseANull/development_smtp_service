# development_smtp_service

A Node.js SMTP development service that catches outgoing emails and provides a web UI to inspect them — so you never accidentally send emails to real users during development.

Inspired by [smtp-impostor](https://github.com/MrAntix/smtp-impostor), rewritten in **Node.js** following [12Factor](https://12factor.net) principles, [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/), **BDD** (Cucumber), and **ISTQB** testing standards.

---

## Features

- **SMTP Server** — listens for incoming SMTP connections and captures all emails in memory
- **REST API** — list, view, and delete captured messages
- **Web UI** — built with [Carbon Design System](https://carbondesignsystem.com) (CDN) and [D3.js](https://d3js.org) for the timeline chart
- **12-Factor configuration** — all settings via environment variables
- **Auto-refresh** — the inbox polls for new messages every 5 seconds

## Quick Start

```bash
# Clone and install
npm install

# Copy and adjust configuration (optional)
cp .env.example .env

# Start the service
npm start
```

The SMTP server will listen on port **2525** and the web UI on port **3000**.

### Sending a test email

```js
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({ host: 'localhost', port: 2525, ignoreTLS: true });
await transporter.sendMail({ from: 'app@example.com', to: 'dev@example.com', subject: 'Test', text: 'Hello!' });
```

Open **http://localhost:3000** to see the captured email.

## Configuration (Environment Variables)

| Variable       | Default     | Description                          |
|----------------|-------------|--------------------------------------|
| `SMTP_HOST`    | `0.0.0.0`   | Address the SMTP server binds to     |
| `SMTP_PORT`    | `2525`      | SMTP server port                     |
| `WEB_HOST`     | `0.0.0.0`   | Address the web server binds to      |
| `WEB_PORT`     | `3000`      | Web UI / API port                    |
| `MAX_MESSAGES` | `200`       | Maximum messages kept in memory      |

## REST API

| Method   | Path                  | Description                   |
|----------|-----------------------|-------------------------------|
| `GET`    | `/api/messages`       | List all captured messages    |
| `GET`    | `/api/messages/:id`   | Get a single message          |
| `DELETE` | `/api/messages/:id`   | Delete a single message       |
| `DELETE` | `/api/messages`       | Clear all messages            |
| `GET`    | `/api/config`         | Show running SMTP config      |
| `GET`    | `/health`             | Liveness probe                |

## Development

```bash
npm test          # run all tests (unit + BDD)
npm run test:unit # Jest unit tests only
npm run test:bdd  # Cucumber BDD scenarios only
npm run lint      # ESLint
```

## Architecture

```
src/
├── smtp/
│   ├── SmtpService.js    # SMTP server (Facade over smtp-server + mailparser)
│   └── MessageStore.js   # In-memory store (Observer/EventEmitter pattern)
├── web/
│   ├── server.js         # Express REST API
│   └── public/
│       └── index.html    # Web UI (Carbon Design System + D3.js)
└── app.js                # Entry point (12-Factor wiring)

tests/
├── unit/
│   ├── MessageStore.test.js
│   └── WebApi.test.js
└── features/
    ├── smtp_capture.feature
    ├── web_api.feature
    └── step_definitions/
```

