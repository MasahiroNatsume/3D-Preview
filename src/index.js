const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const LAYER_FILES = {
  heightmap: "heightmap.png",
  original: "original.png",
  base: "base.png",
  texture: "texture.png",
  color: "color.png",
  varnish: "varnish.png",
};
const MODEL_FILES = ["model.glb", "model.gltf", "model.obj", "model.mtl"];
const ALLOWED_FILES = new Set([
  ...Object.values(LAYER_FILES),
  "config.json",
  ...MODEL_FILES,
]);
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

function withPrivateHeaders(response, status = response.status) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status,
    statusText: response.statusText,
    headers,
  });
}

function secureEqual(actual, expected) {
  let difference = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index++) {
    difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authenticate(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return errorResponse("管理画面のパスワードが設定されていません", 503);
  }

  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Basic ") && authorization.length < 8192) {
    try {
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(authorization.slice(6)), (character) => character.charCodeAt(0)),
      );
      const separator = decoded.indexOf(":");
      const user = separator < 0 ? "" : decoded.slice(0, separator);
      const password = separator < 0 ? "" : decoded.slice(separator + 1);
      if (
        secureEqual(user, env.ADMIN_USER || "admin") &&
        secureEqual(password, env.ADMIN_PASSWORD)
      ) {
        return null;
      }
    } catch {
      // Invalid Basic credentials are handled like any other authentication failure.
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      ...PRIVATE_HEADERS,
      "WWW-Authenticate": 'Basic realm="Atsumori Preview Admin", charset="UTF-8"',
    },
  });
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isExpired(project) {
  return project.expires_at != null && project.expires_at < Math.floor(Date.now() / 1000);
}

async function getProject(env, token) {
  if (!TOKEN_PATTERN.test(token)) return null;
  return env.DB.prepare(
    "SELECT token, title, created_at, expires_at FROM projects WHERE token = ?",
  ).bind(token).first();
}

async function fetchAsset(env, request, path) {
  const assetRequest = path
    ? new Request(new URL(path, request.url), request)
    : request;
  return env.ASSETS.fetch(assetRequest);
}

async function handleAdminPage(request, env, path) {
  const authError = authenticate(request, env);
  if (authError) return authError;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  return withPrivateHeaders(await fetchAsset(env, request, "/"));
}

async function handleProjectList(env, request) {
  let dbProjects = [];
  try {
    const result = await env.DB.prepare(`
    SELECT p.token, p.title, p.created_at, p.expires_at,
           GROUP_CONCAT(f.filename, ',') AS files
    FROM projects p
    LEFT JOIN project_files f ON f.token = p.token
    GROUP BY p.token
    ORDER BY p.created_at DESC
  `).all();

    dbProjects = (result.results || []).map((project) => ({
      token: project.token,
      title: project.title,
      created_at: project.created_at,
      expires_at: project.expires_at,
      files: project.files ? project.files.split(",").sort() : [],
      is_static: false,
    }));
  } catch (error) {
    console.error("Failed to query projects from DB", error);
  }

  let staticProjects = [];
  if (env.ASSETS) {
    try {
      const url = request ? new URL("/static-projects.json", request.url) : new URL("http://localhost/static-projects.json");
      const res = await env.ASSETS.fetch(url);
      if (res.ok) {
        staticProjects = await res.json();
      }
    } catch (error) {
      console.error("Failed to fetch static projects", error);
    }
  }

  const seenTokens = new Set();
  const projects = [];

  for (const project of dbProjects) {
    if (!seenTokens.has(project.token)) {
      seenTokens.add(project.token);
      projects.push(project);
    }
  }

  for (const project of staticProjects) {
    if (!seenTokens.has(project.token)) {
      seenTokens.add(project.token);
      projects.push({
        token: project.token,
        title: project.title,
        created_at: project.created_at,
        expires_at: project.expires_at ?? null,
        files: Array.isArray(project.files) ? project.files : [],
        is_static: true,
      });
    }
  }

  projects.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  return jsonResponse({ projects });
}

async function readBoundedBytes(request, limit) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new HttpError(413, "ファイルが大きすぎます");
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, "ファイルが大きすぎます");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function startsWith(bytes, expected, offset = 0) {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function validateFilePrefix(name, bytes) {
  if (Object.values(LAYER_FILES).includes(name)) {
    if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
    if (startsWith(bytes, [255, 216])) return "image/jpeg";
    if (startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes, [87, 69, 66, 80], 8)) {
      return "image/webp";
    }
    throw new HttpError(400, "PNG / JPEG / WebP のみアップロードできます");
  }
  if (name.endsWith(".glb") && !startsWith(bytes, [103, 108, 84, 70])) {
    throw new HttpError(400, "不正なGLBファイルです");
  }
  return contentTypeFor(name);
}

function contentTypeFor(name) {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".glb")) return "model/gltf-binary";
  if (name.endsWith(".gltf") || name === "config.json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function putSmallFile(request, env, token, name) {
  const bytes = await readBoundedBytes(request, MAX_JSON_BYTES);
  try {
    JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, `${name} が不正な JSON です`);
  }
  await env.PROJECT_FILES.put(`${token}/${name}`, bytes, {
    httpMetadata: { contentType: contentTypeFor(name) },
  });
  return bytes.byteLength;
}

async function putStreamedFile(request, env, token, name) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new HttpError(411, "ファイルサイズを取得できません");
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "ファイルが大きすぎます");
  }
  if (!request.body) throw new HttpError(400, "ファイルが空です");

  const reader = request.body.getReader();
  const prefixChunks = [];
  let prefixLength = 0;
  while (prefixLength < 12) {
    const { done, value } = await reader.read();
    if (done) break;
    prefixLength += value.byteLength;
    if (prefixLength > MAX_UPLOAD_BYTES) throw new HttpError(413, "ファイルが大きすぎます");
    prefixChunks.push(value);
  }

  const prefix = new Uint8Array(prefixLength);
  let prefixOffset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, prefixOffset);
    prefixOffset += chunk.byteLength;
  }
  const contentType = validateFilePrefix(name, prefix);

  const state = { bytes: prefixLength, tooLarge: false };
  const fixedLength = new FixedLengthStream(contentLength);
  const writer = fixedLength.writable.getWriter();
  const pump = (async () => {
    try {
      for (const chunk of prefixChunks) await writer.write(chunk);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        state.bytes += value.byteLength;
        if (state.bytes > MAX_UPLOAD_BYTES) {
          state.tooLarge = true;
          throw new Error("upload too large");
        }
        await writer.write(value);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
  })();

  try {
    await Promise.all([
      env.PROJECT_FILES.put(`${token}/${name}`, fixedLength.readable, {
        httpMetadata: { contentType },
      }),
      pump,
    ]);
  } catch (error) {
    if (state.tooLarge) throw new HttpError(413, "ファイルが大きすぎます");
    throw error;
  }
  return state.bytes;
}

async function createProject(request, env) {
  let data;
  try {
    const bytes = await readBoundedBytes(request, 64 * 1024);
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid json");
  }

  let expiresAt = null;
  if (data.expires_days != null && data.expires_days !== "") {
    const days = Number(data.expires_days);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new HttpError(400, "有効期限は1〜3650日の範囲で指定してください");
    }
    expiresAt = Math.floor(Date.now() / 1000) + Math.ceil(days * 86400);
  }

  const token = newToken();
  const createdAt = Math.floor(Date.now() / 1000);
  const title = String(data.title || "").slice(0, 200);
  await env.DB.prepare(
    "INSERT INTO projects (token, title, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(token, title, createdAt, expiresAt).run();

  return jsonResponse({ token, url: `/p/${token}` }, 201);
}

async function uploadProjectFile(request, env, token, encodedName) {
  if (!TOKEN_PATTERN.test(token)) throw new HttpError(404, "not found");
  const project = await getProject(env, token);
  if (!project) throw new HttpError(404, "not found");

  let name;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (!ALLOWED_FILES.has(name)) throw new HttpError(404, "not found");

  const bytes = name === "config.json" || name.endsWith(".gltf")
    ? await putSmallFile(request, env, token, name)
    : await putStreamedFile(request, env, token, name);

  await env.DB.prepare(
    "INSERT INTO project_files (token, filename, created_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(token, filename) DO UPDATE SET created_at = excluded.created_at",
  ).bind(token, name, Math.floor(Date.now() / 1000)).run();
  return jsonResponse({ ok: true, name, bytes });
}

async function deleteProject(env, token, request) {
  if (env.ASSETS) {
    try {
      const url = request ? new URL("/static-projects.json", request.url) : new URL("http://localhost/static-projects.json");
      const res = await env.ASSETS.fetch(url);
      if (res.ok) {
        const staticProjects = await res.json();
        if (Array.isArray(staticProjects) && staticProjects.some((p) => p.token === token)) {
          throw new HttpError(403, "静的プロジェクトは削除できません");
        }
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error("Failed to verify static project status", error);
    }
  }

  if (!TOKEN_PATTERN.test(token)) throw new HttpError(404, "not found");
  const project = await getProject(env, token);
  if (!project) throw new HttpError(404, "not found");

  const { results } = await env.DB.prepare(
    "SELECT filename FROM project_files WHERE token = ?",
  ).bind(token).all();
  const keys = results.map(({ filename }) => `${token}/${filename}`);
  if (keys.length) await env.PROJECT_FILES.delete(keys);
  await env.DB.prepare("DELETE FROM projects WHERE token = ?").bind(token).run();
  return jsonResponse({ ok: true });
}

const handleProjectDelete = deleteProject;

async function handleAdminApi(request, env, path) {
  const authError = authenticate(request, env);
  if (authError) return authError;

  if (path === "/api/admin/projects" && request.method === "GET") {
    return handleProjectList(env, request);
  }
  if (path === "/api/admin/projects" && request.method === "POST") {
    return createProject(request, env);
  }

  const uploadMatch = path.match(/^\/api\/admin\/projects\/([^/]+)\/files\/([^/]+)$/);
  if (uploadMatch && request.method === "PUT") {
    return uploadProjectFile(request, env, uploadMatch[1], uploadMatch[2]);
  }

  const deleteMatch = path.match(/^\/api\/admin\/projects\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    return deleteProject(env, deleteMatch[1], request);
  }

  return errorResponse("not found", 404);
}

async function handleShare(request, env, url) {
  const pageMatch = url.pathname.match(/^\/p\/([^/]+)\/?$/);
  const manifestMatch = url.pathname.match(/^\/p\/([^/]+)\/manifest\.json$/);
  const fileMatch = url.pathname.match(/^\/p\/([^/]+)\/files\/([^/]+)$/);
  const match = pageMatch || manifestMatch || fileMatch;
  if (!match || !TOKEN_PATTERN.test(match[1])) return env.ASSETS.fetch(request);

  const token = match[1];
  const project = await getProject(env, token);
  if (!project) return withPrivateHeaders(await env.ASSETS.fetch(request));
  if (isExpired(project)) return new Response("この共有リンクは有効期限切れです", { status: 410, headers: PRIVATE_HEADERS });

  if (pageMatch) {
    return withPrivateHeaders(await fetchAsset(env, request, "/viewer/"));
  }
  if (manifestMatch) {
    const { results } = await env.DB.prepare(
      "SELECT filename FROM project_files WHERE token = ?",
    ).bind(token).all();
    const names = new Set(results.map(({ filename }) => filename));
    const files = Object.fromEntries(
      Object.entries(LAYER_FILES)
        .filter(([, filename]) => names.has(filename))
        .map(([key, filename]) => [key, `files/${filename}`]),
    );
    const manifest = {
      title: project.title,
      files,
      config: names.has("config.json") ? "files/config.json" : null,
    };
    const model = MODEL_FILES.find((filename) =>
      ["model.glb", "model.gltf", "model.obj"].includes(filename) && names.has(filename),
    );
    if (model) manifest.model = `files/${model}`;
    return jsonResponse(manifest);
  }

  let name;
  try {
    name = decodeURIComponent(fileMatch[2]);
  } catch {
    return new Response("Not Found", { status: 404, headers: PRIVATE_HEADERS });
  }
  if (!ALLOWED_FILES.has(name)) return new Response("Not Found", { status: 404, headers: PRIVATE_HEADERS });

  const fileRecord = await env.DB.prepare(
    "SELECT filename FROM project_files WHERE token = ? AND filename = ?",
  ).bind(token, name).first();
  if (!fileRecord) return new Response("Not Found", { status: 404, headers: PRIVATE_HEADERS });

  const object = await env.PROJECT_FILES.get(`${token}/${name}`);
  if (!object) return new Response("Not Found", { status: 404, headers: PRIVATE_HEADERS });
  const headers = new Headers(PRIVATE_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/" || path === "/index.html" || path === "/admin" || path === "/admin/" || path === "/admin.html") {
        return handleAdminPage(request, env, path);
      }
      if (path.startsWith("/api/admin/")) return await handleAdminApi(request, env, path);
      if (path.startsWith("/p/")) return await handleShare(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.message, error.status);
      console.error("Worker request failed", error);
      return errorResponse("Internal server error", 500);
    }
  },
};