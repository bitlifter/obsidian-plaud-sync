import { createServer, Server } from "http";
import { randomBytes, createHash } from "crypto";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { requestUrl } from "obsidian";
import { PlaudTokenSet } from "./types";

const CLIENT_ID = "client_9c501dad-8a0d-40b2-a7b0-d1cb8787f674";
const REDIRECT_URI = "http://localhost:8199/auth/callback";
const AUTH_URL = "https://web.plaud.ai/platform/oauth";
const TOKEN_URL = "https://platform.plaud.ai/developer/api/oauth/third-party/access-token";
const CALLBACK_PORT = 8199;
const LOGIN_TIMEOUT_MS = 120000; // 2 minutes

let activeServer: Server | null = null;

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("base64url");
}

function getSuccessHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Plaud Connected to Obsidian</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #181825;
      color: #cdd6f4;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: #1e1e2e;
      border: 1px solid #313244;
      border-radius: 16px;
      padding: 40px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      max-width: 440px;
    }
    h1 { color: #a6e3a1; font-size: 26px; margin: 0 0 12px; }
    p { color: #a6adc8; line-height: 1.5; margin: 0 0 8px; font-size: 15px; }
    .hint { color: #6c7086; font-size: 13px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✓ Plaud Connected!</h1>
    <p>Your Plaud account has been successfully authorized and linked to Obsidian.</p>
    <p class="hint">You can safely close this browser window and return to Obsidian.</p>
  </div>
</body>
</html>`;
}

function getErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Plaud Authorization Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #181825;
      color: #cdd6f4;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: #1e1e2e;
      border: 1px solid #f38ba8;
      border-radius: 16px;
      padding: 40px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      max-width: 440px;
    }
    h1 { color: #f38ba8; font-size: 24px; margin: 0 0 12px; }
    p { color: #bac2de; line-height: 1.5; margin: 0 0 8px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorization Failed</h1>
    <p>${message}</p>
    <p style="color:#6c7086; margin-top:16px;">Please return to Obsidian and try again.</p>
  </div>
</body>
</html>`;
}

export async function startPlaudOAuthLogin(): Promise<PlaudTokenSet> {
  // If a previous server was left open, close it
  if (activeServer) {
    try {
      activeServer.close();
    } catch {
      // ignore
    }
    activeServer = null;
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const expectedState = generateState();

  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: expectedState
  });

  const authorizationUrl = `${AUTH_URL}?${authParams.toString()}`;

  return new Promise<PlaudTokenSet>((resolve, reject) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (activeServer) {
        try {
          activeServer.close();
        } catch {
          // ignore
        }
        activeServer = null;
      }
    };

    const server = createServer(async (req, res) => {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      };

      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      const reqUrl = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (reqUrl.pathname !== "/auth/callback") {
        res.writeHead(404, corsHeaders);
        res.end("Not Found");
        return;
      }

      const params = reqUrl.searchParams;
      const error = params.get("error");
      const state = params.get("state");
      const code = params.get("code");

      if (error) {
        const desc = params.get("error_description") || error;
        res.writeHead(400, { "Content-Type": "text/html", ...corsHeaders });
        res.end(getErrorHtml(`Authorization denied: ${desc}`));
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`Plaud authorization denied: ${desc}`));
        }
        return;
      }

      if (!state || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html", ...corsHeaders });
        res.end(getErrorHtml("Invalid state parameter. Authorization request mismatch."));
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("State mismatch in OAuth callback."));
        }
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html", ...corsHeaders });
        res.end(getErrorHtml("Missing authorization code."));
        return;
      }

      try {
        // Exchange code for tokens
        const basicAuth = Buffer.from(`${CLIENT_ID}:`).toString("base64");
        const bodyParams = new URLSearchParams({
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: codeVerifier,
          state
        });

        const tokenRes = await requestUrl({
          url: TOKEN_URL,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            Authorization: `Basic ${basicAuth}`
          },
          body: bodyParams.toString(),
          throw: false
        });

        if (tokenRes.status !== 200) {
          throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${tokenRes.text}`);
        }

        const data = tokenRes.json;
        const tokenSet: PlaudTokenSet = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          token_type: data.token_type || "bearer",
          expires_at: data.expires_in
            ? Date.now() + data.expires_in * 1000
            : undefined
        };

        // Save to ~/.plaud/tokens-mcp.json
        const tokenPath = path.join(os.homedir(), ".plaud", "tokens-mcp.json");
        await fsPromises.mkdir(path.dirname(tokenPath), { recursive: true });
        await fsPromises.writeFile(tokenPath, JSON.stringify(tokenSet, null, 2), "utf-8");

        // Respond to browser
        res.writeHead(200, { "Content-Type": "text/html", ...corsHeaders });
        res.end(getSuccessHtml());

        if (!settled) {
          settled = true;
          setTimeout(() => cleanup(), 1500);
          resolve(tokenSet);
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "text/html", ...corsHeaders });
        res.end(getErrorHtml(err.message));
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      }
    });

    server.on("error", (err: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      const msg =
        err.code === "EADDRINUSE"
          ? `Port ${CALLBACK_PORT} is already in use. Please wait a moment or stop other Plaud auth tools and try again.`
          : `OAuth callback server error: ${err.message}`;
      reject(new Error(msg));
    });

    server.listen(CALLBACK_PORT, "localhost", () => {
      activeServer = server;

      // Set timeout
      timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Plaud login timed out. Authorization was not completed within 2 minutes."));
        }
      }, LOGIN_TIMEOUT_MS);

      // Open user's browser
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { shell } = require("electron");
        if (shell && typeof shell.openExternal === "function") {
          shell.openExternal(authorizationUrl);
          return;
        }
      } catch {
        // Fallback
      }
      window.open(authorizationUrl, "_blank");
    });
  });
}
