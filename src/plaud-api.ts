import { requestUrl } from "obsidian";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { PlaudTokenSet, PlaudFileItem } from "./types";

export interface PlaudAuthStatus {
  state: "connected" | "expired" | "disconnected";
  label: string;
  detail: string;
}

export class PlaudApiClient {
  private tokenPath: string;
  private tokenSet: PlaudTokenSet | null = null;
  private baseUrl = "https://platform.plaud.ai/developer/api";

  constructor() {
    this.tokenPath = path.join(os.homedir(), ".plaud", "tokens-mcp.json");
  }

  public async hasLocalTokens(): Promise<boolean> {
    try {
      await fsPromises.access(this.tokenPath);
      return true;
    } catch {
      return false;
    }
  }

  public async checkAuthStatus(): Promise<PlaudAuthStatus> {
    try {
      await fsPromises.access(this.tokenPath);
    } catch {
      return {
        state: "disconnected",
        label: "Not Connected",
        detail: "No credentials found. Click 'Connect Account' to authenticate."
      };
    }

    try {
      // Validate or refresh token
      const token = await this.getValidAccessToken();

      // Test active connectivity with lightweight ping
      const res = await requestUrl({
        url: `${this.baseUrl}/open/third-party/files/?page=1&page_size=1`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        throw: false
      });

      if (res.status === 200) {
        return {
          state: "connected",
          label: "Connected",
          detail: `Connected via ${this.tokenPath}`
        };
      } else if (res.status === 401) {
        return {
          state: "expired",
          label: "Session Expired",
          detail: "Plaud session has expired. Click 'Re-authenticate' to log in."
        };
      } else {
        return {
          state: "connected",
          label: "Connected (Offline)",
          detail: `Cached session valid, API returned HTTP ${res.status}.`
        };
      }
    } catch (err: any) {
      return {
        state: "expired",
        label: "Session Expired",
        detail: `Authentication error: ${err.message || err}`
      };
    }
  }

  public async loadTokens(): Promise<PlaudTokenSet> {
    try {
      const data = await fsPromises.readFile(this.tokenPath, "utf-8");
      this.tokenSet = JSON.parse(data);
      return this.tokenSet!;
    } catch (err: any) {
      throw new Error(
        `No Plaud credentials found at ${this.tokenPath}. Please authenticate via 'Connect Account' in settings.`
      );
    }
  }

  public async saveTokens(tokens: Partial<PlaudTokenSet>): Promise<void> {
    this.tokenSet = { ...this.tokenSet, ...tokens } as PlaudTokenSet;
    const dir = path.dirname(this.tokenPath);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(this.tokenPath, JSON.stringify(this.tokenSet, null, 2), "utf-8");
  }

  public async getValidAccessToken(): Promise<string> {
    if (!this.tokenSet) {
      await this.loadTokens();
    }

    if (!this.tokenSet?.access_token) {
      throw new Error("No access_token found in Plaud token set.");
    }

    const nowMs = Date.now();
    let expiresMs: number | undefined;
    if (this.tokenSet.expires_at) {
      expiresMs = this.tokenSet.expires_at > 1e11
        ? this.tokenSet.expires_at
        : this.tokenSet.expires_at * 1000;
    }

    if (expiresMs && nowMs >= expiresMs - 60000) {
      if (this.tokenSet.refresh_token) {
        await this.refreshAccessToken();
      }
    }

    return this.tokenSet.access_token;
  }

  public async refreshAccessToken(): Promise<string> {
    if (!this.tokenSet?.refresh_token) {
      throw new Error("No refresh_token available to refresh access token.");
    }

    const url = `${this.baseUrl}/oauth/third-party/access-token/refresh`;
    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        refresh_token: this.tokenSet.refresh_token
      }).toString(),
      throw: false
    });

    if (res.status !== 200) {
      throw new Error(`Failed to refresh Plaud token (HTTP ${res.status}): ${res.text}`);
    }

    const data = res.json;
    const tokenPayload = data.data || data;
    await this.saveTokens({
      access_token: tokenPayload.access_token,
      refresh_token: tokenPayload.refresh_token || this.tokenSet.refresh_token,
      token_type: tokenPayload.token_type || "bearer",
      expires_at: tokenPayload.expires_in
        ? Date.now() + tokenPayload.expires_in * 1000
        : (tokenPayload.expires_at || undefined)
    });

    return this.tokenSet!.access_token;
  }

  private async request(endpoint: string, options: { method?: string; body?: any } = {}): Promise<any> {
    let token = await this.getValidAccessToken();
    const url = endpoint.startsWith("http") ? endpoint : `${this.baseUrl}${endpoint}`;

    let res = await requestUrl({
      url,
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      throw: false
    });

    if (res.status === 401 && this.tokenSet?.refresh_token) {
      token = await this.refreshAccessToken();
      res = await requestUrl({
        url,
        method: options.method || "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        throw: false
      });
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Plaud API error ${res.status} on ${endpoint}: ${res.text}`);
    }

    return res.json;
  }

  public async listFiles(pageSize = 100): Promise<PlaudFileItem[]> {
    let allFiles: PlaudFileItem[] = [];
    let page = 1;

    while (true) {
      const endpoint = `/open/third-party/files/?page=${page}&page_size=${pageSize}`;
      const data = await this.request(endpoint);

      const items = Array.isArray(data.data) ? data.data : (data.data?.items || data.data?.file_list || []);
      if (!Array.isArray(items) || items.length === 0) {
        break;
      }

      allFiles.push(...items);

      if (items.length < pageSize) {
        break;
      }
      page++;
    }

    return allFiles;
  }

  public async getFileDetail(fileId: string): Promise<any> {
    const raw = await this.request(`/open/third-party/files/${fileId}`);
    const data = raw.data || raw;

    if (data.data_link) {
      try {
        const linkRes = await requestUrl({ url: data.data_link, throw: false });
        if (linkRes.status === 200) {
          const payload = linkRes.json;
          return { ...data, payload };
        }
      } catch (err: any) {
        console.warn(`Failed to resolve data_link for ${fileId}: ${err.message}`);
      }
    }

    return data;
  }

  public async loadBlockContent(block: any): Promise<string> {
    if (!block) return "";
    const inline = block.data_content;
    if (typeof inline === "string" && inline.length > 0) {
      return inline;
    }
    const link = block.data_link;
    if (typeof link === "string" && link.length > 0) {
      try {
        const res = await requestUrl({ url: link, throw: false });
        if (res.status === 200) {
          return res.text;
        }
      } catch (err: any) {
        console.warn(`Failed to fetch block content from data_link: ${err.message}`);
      }
    }
    return "";
  }

  public async downloadAudioBuffer(fileId: string, directUrl?: string): Promise<ArrayBuffer> {
    let downloadUrl = directUrl;

    if (!downloadUrl) {
      const audioInfo = await this.request(`/open/third-party/files/${fileId}/audio`);
      downloadUrl = audioInfo.data?.url || audioInfo.data?.audio_url || audioInfo.url;
    }

    if (!downloadUrl) {
      throw new Error(`No audio download URL returned for file ${fileId}`);
    }

    const res = await requestUrl({
      url: downloadUrl,
      throw: false
    });

    if (res.status !== 200) {
      throw new Error(`Failed to download audio from ${downloadUrl} (HTTP ${res.status})`);
    }

    return res.arrayBuffer;
  }
}
