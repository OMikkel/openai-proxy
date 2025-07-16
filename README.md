# OpenAI Proxy Server

This is a proxy for OpenAI's API with with own API key management. It is designed to handle student access to LLMs in a large classes where access can be managed and logged. 

## Features

- **API Key Management**: Restrict access to the proxy using per-user API keys stored in `keys.json` (hot-reloads on change).
- **Usage Logging**: All usage is logged to a local SQLite database (`usage.sqlite`) for reporting and auditing.
- **Access Logging**: All requests are logged to `access.log` (with sensitive data redacted).
- **OpenAI API Forwarding**: Forwards requests to OpenAI's API, adding your configured API key.
- **Large Payload Support**: Handles requests up to 50MB (for image/multimodal support).
- **CORS Support**: Allows cross-origin requests.
- **Utility Scripts**:
  - `create.js`: Add new API keys to `keys.json`.
  - `bulk_create.js`: Add multiple users from a CSV file (see below).
  - `usage.js`: Report usage by user or for all users.

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


   - **Single user:**
     ```sh
     node create.js <name> <email>
     ```
     - Both `<name>` and `<email>` are required. The script will auto-generate a secure random API key and add the user to `keys.json`.
     - Interactive mode is not supported; you must provide both arguments.

   - **Bulk add users from CSV:**
     ```sh
     node bulk_create.js <users.csv>
     ```
     - The CSV file should have headers: `name,email`.
     - Users whose emails already exist in `keys.json` will be skipped (with a log message).
     - Example CSV:
       ```csv
       name,email
       Alice Smith,alice@example.com
       Bob Jones,bob@example.com
       ...
       ```
     - A sample file `sample_users.csv` is provided.

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

## Scaling & Cleanup

The proxy is designed to handle high-volume usage (e.g., 150 students uploading hundreds of audio files) with built-in scaling and cleanup mechanisms:

### **Automatic File Cleanup**
- **Temporary Storage**: Audio uploads use disk storage (not RAM) in `temp-uploads/` directory
- **Automatic Cleanup**: Temp files are deleted immediately after processing
- **Scheduled Cleanup**: Every 5 minutes, removes any orphaned files older than 10 minutes
- **Graceful Shutdown**: Cleans up all temp files when server stops

### **Rate Limiting**
- **Upload Limits**: Max 10 concurrent uploads per user (prevents resource exhaustion)
- **File Limits**: Max 5 files per request, 50MB per file
- **File Type Validation**: Only allows audio formats for audio endpoints

### **Log Management**
- **Log Rotation**: Automatically rotates `access.log` when it exceeds 100MB
- **Backup Retention**: Keeps last 5 log backups, automatically deletes older ones
- **Memory Efficient**: Logs are written to disk, not stored in memory

### **Memory Management**
- **Disk Storage**: Files are written to disk instead of RAM
- **Immediate Cleanup**: Files removed as soon as request completes (success or failure)
- **Error Handling**: Cleanup occurs even on timeouts, errors, or interruptions

### **Resource Monitoring**
```bash
# Monitor temp files
ls -la temp-uploads/

# Monitor log size
ls -lh access.log*

# Monitor active uploads (server logs)
# Look for rate limiting messages in console
```

## Acknowledgement

This proxy was developed with the assistance of AI (GitHub Copilot, GPT-4.1).

## License

MIT
