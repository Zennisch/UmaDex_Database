const fs = require("fs");
const path = require("path");

// Configuration
const GAMETORA_BASE_URL = "https://gametora.com";
const OUTPUT_DIR = __dirname;

// User Agent Configuration
const repoUrl = "https://github.com/zennisch/UmaDex_Database";
const contactEmail = process.env.CONTACT_EMAIL || "";
const USER_AGENT = `UmaDex-SyncBot/1.0 (+${repoUrl}${contactEmail ? `; ${contactEmail}` : ""})`;

// Helper to apply XOR obfuscation
function obfuscate(buffer) {
  const xorKey = 0x5A;
  const result = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    result[i] = buffer[i] ^ xorKey;
  }
  return result;
}

// Fetch helper with User-Agent
async function fetchWithRetry(url, isBinary = false, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Fetching: ${url} (Attempt ${i + 1}/${retries})`);
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (isBinary) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } else {
        return await response.text();
      }
    } catch (error) {
      console.warn(`Attempt ${i + 1} failed for ${url}:`, error.message);
      if (i === retries - 1) throw error;
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

function getManifestDataFiles(manifest) {
  const files = new Set();

  for (const [field, hash] of Object.entries(manifest)) {
    if (typeof hash !== "string" || !hash) continue;
    files.add(path.normalize(`${field}.${hash}.json`));
  }

  return files;
}

function removeEmptyDirectories(directory, rootDirectory) {
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirectories(path.join(directory, entry.name), rootDirectory);
    }
  }

  if (directory === rootDirectory) return;
  if (fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
}

function cleanupStaleDataFiles(manifest, syncedFiles) {
  const dataRoot = path.join(OUTPUT_DIR, "data", "umamusume");
  if (!fs.existsSync(dataRoot)) return;

  const expectedFiles = getManifestDataFiles(manifest);
  for (const file of syncedFiles) {
    expectedFiles.add(path.normalize(file));
  }

  let removedCount = 0;

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      const relativePath = path.normalize(path.relative(dataRoot, entryPath));
      if (!expectedFiles.has(relativePath)) {
        fs.unlinkSync(entryPath);
        removedCount++;
        console.log(`- Removed stale data file: ${path.join("data", "umamusume", relativePath)}`);
      }
    }
  }

  visit(dataRoot);
  removeEmptyDirectories(dataRoot, dataRoot);
  console.log(`- Stale data files removed: ${removedCount}`);
}

async function syncDbFile(file, syncedFiles) {
  const relativeFile = path.normalize(`${file.field}.${file.hash}.json`);
  const url = `${GAMETORA_BASE_URL}/data/umamusume/${relativeFile.replace(/\\/g, "/")}`;
  const text = await fetchWithRetry(url, false);

  const filePath = path.join(OUTPUT_DIR, "data", "umamusume", relativeFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, obfuscate(Buffer.from(text)));
  syncedFiles.add(relativeFile);
  console.log(`✓ ${relativeFile.replace(/\\/g, "/")} synchronized & obfuscated.`);

  return text;
}

// Main Sync Function
async function main() {
  console.log("Starting UmaDex Data Mirror Sync...");
  console.log(`Using User-Agent: ${USER_AGENT}`);

  try {
    // 1. Fetch & obfuscate Manifest
    const manifestUrl = `${GAMETORA_BASE_URL}/data/manifests/umamusume.json`;
    const manifestText = await fetchWithRetry(manifestUrl, false);
    const manifest = JSON.parse(manifestText);

    // Save obfuscated manifest
    const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, obfuscate(Buffer.from(manifestText)));
    console.log("✓ Manifest synchronized and obfuscated.");

    // 2. Fetch & obfuscate DB JSON files
    const syncedDataFiles = new Set();
    const dbFiles = [
      { field: "db-files/succession_relation", hash: manifest["db-files/succession_relation"] },
      { field: "db-files/succession_relation_member", hash: manifest["db-files/succession_relation_member"] },
    ];

    for (const file of dbFiles) {
      await syncDbFile(file, syncedDataFiles);
    }

    const charactersText = await syncDbFile(
      { field: "characters", hash: manifest.characters },
      syncedDataFiles
    );

    const cardsText = await syncDbFile(
      { field: "character-cards", hash: manifest["character-cards"] },
      syncedDataFiles
    );

    cleanupStaleDataFiles(manifest, syncedDataFiles);

    // 3. Cache character portrait thumbnail images
    console.log("Parsing character list for thumbnail image caching...");
    const characters = JSON.parse(charactersText);
    const cards = JSON.parse(cardsText);
    
    // Pre-build char_id -> card_id map
    const charToCard = {};
    for (const card of cards) {
      if (!charToCard[card.char_id]) {
        charToCard[card.char_id] = card.card_id;
      }
    }

    let successCount = 0;
    let skipCount = 0;

    for (const chara of characters) {
      const cardId = charToCard[chara.char_id];
      if (!cardId) continue;

      const imgName = `chara_stand_${chara.char_id}_${cardId}.png`;
      const imgPath = path.join(OUTPUT_DIR, "images", "umamusume", "characters", "thumb", imgName);

      // Check if image already exists locally to skip downloading (smart incremental cache)
      if (fs.existsSync(imgPath)) {
        skipCount++;
        continue;
      }

      const imgUrl = `${GAMETORA_BASE_URL}/images/umamusume/characters/thumb/${imgName}`;
      try {
        const imgBuffer = await fetchWithRetry(imgUrl, true);
        fs.mkdirSync(path.dirname(imgPath), { recursive: true });
        fs.writeFileSync(imgPath, obfuscate(imgBuffer));
        successCount++;
      } catch (err) {
        console.error(`✗ Failed to download image ${imgName}:`, err.message);
      }
    }

    console.log(`\nSync Completed Successfully!`);
    console.log(`- Images downloaded & obfuscated: ${successCount}`);
    console.log(`- Images skipped (already cached): ${skipCount}`);
  } catch (error) {
    console.error("Critical Sync Error:", error.message);
    process.exit(1);
  }
}

main();
