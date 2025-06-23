# OpenAI Proxy Server

A secure, auditable proxy for OpenAI's API with API key management, usage logging (SQLite), and utility scripts for key management and usage reporting.

## Features

- **API Key Management**: Restrict access to the proxy using per-user API keys stored in `keys.json` (hot-reloads on change).
- **Usage Logging**: All usage is logged to a local SQLite database (`usage.sqlite`) for reporting and auditing.
- **Access Logging**: All requests are logged to `access.log` (with sensitive data redacted).
- **OpenAI API Forwarding**: Forwards requests to OpenAI's API, adding your configured API key.
- **Large Payload Support**: Handles requests up to 50MB (for image/multimodal support).
- **CORS Support**: Allows cross-origin requests.
- **Utility Scripts**:
  - `create.js`: Add new API keys to `keys.json`.
  - `usage.js`: Report usage by user or for all users.
- **Security**: Sensitive files (`config.json`, `keys.json`, `usage.sqlite`, `access.log`) are gitignored by default.
- **Redacted Logging**: Base64 image data is redacted in logs, with a short prefix for traceability.

## Setup

1. **Clone the repository**

2. **Install dependencies**

   ```sh
   npm install
   ```

3. **Configure OpenAI API Key**

   - Copy `config-example.json` to `config.json` and add your OpenAI API key:
     ```json
     { "OPENAI_API_KEY": "sk-..." }
     ```

4. **Add API Users**

   - Edit `keys.json` to add users manually (see below), or use the `create.js` script:
     ```sh
     node create.js <name> <email>
     ```
     - Both `<name>` and `<email>` are required. The script will auto-generate a secure random API key and add the user to `keys.json`.
     - Interactive mode is not supported; you must provide both arguments.

   - Example `keys.json` entry:
     ```json
     [
       { "key": "user-api-key-1", "name": "Alice", "email": "alice@example.com" },
       { "key": "user-api-key-2", "name": "Bob", "email": "bob@example.com" }
     ]
     ```
   - Save the file. The proxy will hot-reload the keys automatically.

5. **Run the Proxy**

   ```sh
   node index.js
   ```
   The proxy will listen on `http://localhost:8080`.

## Usage

### Making Requests

- Send requests to the proxy endpoint (e.g., `/v1/chat/completions`).
- Include your assigned API key in the `api-key` header.
- The proxy will forward the request to OpenAI, log usage, and return the response.

### Usage Reporting

- **Per-user usage:**
  ```sh
  node usage.js user@example.com
  ```
- **All users summary:**
  ```sh
  node usage.js
  ```

## Security & Privacy

- All sensitive/runtime files are gitignored.
- Base64 image data is redacted in logs (only a short prefix is shown for traceability).
- Only valid API keys in `keys.json` can access the proxy.

## File Overview

- `index.js` — Main proxy server
- `create.js` — Add new API keys
- `usage.js` — Usage reporting tool
- `keys.json` — API key storage (gitignored)
- `config.json` — OpenAI API key (gitignored)
- `usage.sqlite` — Usage database (gitignored)
- `access.log` — Access log (gitignored)

## License

MIT
