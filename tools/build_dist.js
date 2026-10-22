const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const dataDir = path.join(root, "data");
const templatesDir = path.join(root, "templates");
const staticDir = path.join(root, "static");

async function build() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  for (const name of ["index.html", "admin.html", "notfound.html"]) {
    await fs.copyFile(path.join(templatesDir, name), path.join(dist, name));
  }
  await fs.copyFile(path.join(templatesDir, "admin.html"), path.join(dist, "index.html"));
  await fs.cp(staticDir, path.join(dist, "static"), { recursive: true });

  const viewerHtml = await fs.readFile(path.join(templatesDir, "viewer.html"), "utf8");
  await fs.mkdir(path.join(dist, "viewer"), { recursive: true });
  await fs.writeFile(path.join(dist, "viewer", "index.html"), viewerHtml, "utf8");

  let tokens = [];
  try {
    tokens = await fs.readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const token of tokens.filter((entry) => entry.isDirectory())) {
    const sourceDir = path.join(dataDir, token.name);
    const projectDir = path.join(dist, "p", token.name);
    const filesDir = path.join(projectDir, "files");
    await fs.mkdir(filesDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "index.html"), viewerHtml, "utf8");

    for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === "meta.json") continue;
      const targetDir = entry.name === "manifest.json" ? projectDir : filesDir;
      await fs.copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
    }
  }

  console.log("dist build completed successfully.");
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});